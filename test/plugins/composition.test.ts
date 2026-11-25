import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writePlugin } from '../support/plugin-fixture.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, waitUntil } from '../support/api-fixture.ts';

const examples = fileURLToPath(new URL('../../docs/examples/', import.meta.url));
function copyExample(directory: string, id: string) {
  cpSync(join(examples, id), join(directory, id), { recursive: true });
}
test('external services and their declared consumers compose through Cordis service ownership', async (t) => {
  const { paths, request } = await fixture(t);
  copyExample(paths.plugins, 'greeting-route');
  copyExample(paths.plugins, 'greeting-service');
  const patch = (data: unknown) => request('/settings', 'PATCH', data);
  const endpoint = '/extensions/greeting-route/hello?name=Harness';
  assert.equal((await patch({ entries: { 'greeting-route': { disabled: false } } })).status, 200);
  assert.equal((await request(endpoint)).status, 404);
  assert.equal((await patch({ entries: { 'greeting-route': { disabled: false }, 'greeting-service': { disabled: false } } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness');
  writePlugin(
    paths.plugins,
    'suffix',
    {},
    "export const provide = [\"exampleSuffix\"];\nexport const apply = (ctx) => { ctx.provide('exampleSuffix', '!'); };",
  );
  assert.equal((await patch({ entries: { suffix: { disabled: false } } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');

  writePlugin(
    paths.plugins,
    'greeting-alt',
    {},
    "export const provide = [\"exampleGreeting\"];\nexport const apply = (ctx) => { ctx.provide('exampleGreeting', { greet: (name) => 'Welcome, ' + name }); };",
  );
  assert.match((await patch({ entries: { 'greeting-alt': { disabled: false } } })).body.error, /has been registered/);
  assert.equal(
    (await patch({ entries: { 'greeting-service': { disabled: true }, 'greeting-alt': { disabled: false } } }))
      .status,
    200,
  );
  assert.equal((await request(endpoint)).body.greeting, 'Welcome, Harness!');
  const graph = (await request('/plugins/diagnostics')).body;
  assert.equal(
    expectPresent(
      graph.find(({ id }: { id: string }) => id === 'greeting-route'),
      'greeting route',
    ).services.exampleGreeting,
    'greeting-alt',
  );
  assert.equal((await patch({ entries: { 'greeting-alt': { disabled: true }, 'greeting-service': { disabled: false } } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');
});

test('Shell delegates to a selected external process provider and still requires approval', async (t) => {
  const { paths, app, request } = await fixture(t);
  copyExample(paths.plugins, 'process-preview');
  const result = await request('/settings', 'PATCH', {
    entries: { shell: { disabled: false }, 'core:process': { disabled: true }, 'process-preview': { disabled: false } },

  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { id } = app.runtime.plugins.ctx.harnessRegistry.create();
  const tool = expectPresent(
    app.runtime.plugins.ctx.harnessTools.forSession(id).find(({ name }) => name === 'sandbox_shell'),
    'shell tool',
  );
  const execution = tool.execute('preview', { command: 'Preview command' }, undefined, undefined, undefined);
  const pending = await waitUntil(
    () => request('/approvals'),
    ({ body }) => body.length === 1,
  );
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: true });
  const response = await execution;
  assert.match(JSON.stringify(response.content), /Preview command/);
});

test('scoped plugins inherit declared services and tool policies, and release their own resources', async (t) => {
  const { app, paths, root, request, mock } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Finished greeting' : { tool: 'scoped_greeting', args: {} },
  );
  copyExample(paths.plugins, 'scoped-tool');
  const cleaned = join(root, 'released');
  writePlugin(
    paths.plugins,
    'workspace-greeting',
    { scope: 'workspace' },
    `
export const provide = ["exampleGreeting"];
export const inject = ["harnessSessions","harnessPluginRoutes","harnessPluginData","harnessPluginChanges","harnessTools"];
import { pluginScope } from 'mini-harness/plugin-scope';
import { appendFileSync } from 'node:fs';
export const apply = (ctx, config) => {
      if (config.fail) throw new Error('Scoped setup failed');
      ctx.effect(() => () => appendFileSync(${JSON.stringify(cleaned)}, 'released\\n'));
      ctx.provide('exampleGreeting', { greet: (name) => pluginScope(ctx).workspaceId + ':' + name });
      const sessions = ctx.harnessSessions.access();
      ctx.harnessPluginRoutes.scope('start', () => sessions.create({ title: 'Scoped root' }));
      ctx.harnessPluginRoutes.scope('tools', (id) => ctx.harnessTools.forSession(id).map(({ name }) => name));
      ctx.harnessPluginRoutes.scope('greet', (input) => {
        ctx.harnessPluginData.write('seen', input);
        ctx.harnessPluginChanges.invalidate();
        return { workspaceId: pluginScope(ctx).workspaceId, input };
      });
    };
`,
  );
  const secondWorkspace = join(root, 'other');
  mkdirSync(secondWorkspace);
  const workspace = (await request('/workspaces', 'POST', { path: secondWorkspace })).body;
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const outside = app.runtime.plugins.ctx.harnessRegistry.create({ workspaceId: workspace.id });
  const workspaceKey = 'workspace:' + parent.workspaceId;
  const sessionKey = 'session:' + parent.id;
  const scopes = {
    [workspaceKey]: { entries: { 'workspace-greeting': { disabled: false } } },
    [sessionKey]: { entries: { 'scoped-tool': { disabled: false } }, disabledTools: ['read'] },
  };
  const enabled = await request('/settings', 'PATCH', { scopes });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(existsSync(cleaned), false);
  const operation = (key: string, action = 'greet') =>
    '/plugins/workspace-greeting/scopes/' + encodeURIComponent(key) + '/' + action;
  const created = await request(operation(workspaceKey, 'start'), 'POST', {});
  assert.equal(created.status, 200);
  assert.equal(created.body.parentId, null);
  assert.equal(created.body.workspaceId, parent.workspaceId);
  assert.deepEqual((await request(operation(workspaceKey), 'POST', { input: 'World' })).body, {
    workspaceId: parent.workspaceId,
    input: 'World',
  });
  assert.equal((await request(operation('workspace:' + workspace.id), 'POST', {})).status, 404);
  const instance = join(
    paths.home,
    'plugin-data',
    'workspace-greeting',
    createHash('sha256').update(workspaceKey).digest('hex'),
  );
  assert.ok(existsSync(join(instance, 'seen.json')));
  for (const id of [parent.id, child.id, sibling.id, outside.id])
    await app.runtime.plugins.prepare(`session:${id}`);
  const tools = app.runtime.plugins.ctx.harnessTools;
  const names = (id: string) => tools.forSession(id).map(({ name }) => name);
  assert.ok(names(parent.id).includes('scoped_greeting'));
  assert.ok(
    (await request(operation(workspaceKey, 'tools'), 'POST', { input: parent.id })).body.includes(
      'scoped_greeting',
    ),
  );
  assert.deepEqual((await request(operation(workspaceKey, 'tools'), 'POST', { input: outside.id })).body, []);
  assert.ok(names(child.id).includes('scoped_greeting'));
  assert.ok(!names(child.id).includes('read'));
  for (const id of [sibling.id, outside.id]) {
    assert.ok(!names(id).includes('scoped_greeting'));
    assert.ok(names(id).includes('read'));
  }
  const tool = expectPresent(
    tools.forSession(child.id).find(({ name }) => name === 'scoped_greeting'),
    'scoped greeting tool',
  );
  assert.match(
    JSON.stringify(await tool.execute('scope', {}, undefined, undefined, undefined)),
    new RegExp(parent.id),
  );
  assert.equal(
    await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Run scoped greeting'),
    'Finished greeting',
  );
  const saved = (await request('/sessions/' + parent.id)).body;
  assert.equal(
    expectPresent(
      saved.messages.find(
        (message: { role: string; content: { text?: string }[] }) => message.role === 'toolResult',
      ),
      'persisted tool result',
    ).content[0]?.text,
    'Greeting returned.',
  );
  assert.ok(JSON.stringify(mock.requests).includes(parent.workspaceId + ':' + parent.id));

  const rejected = await request('/settings', 'PATCH', {
    scopes: {
      ...scopes,
      [workspaceKey]: {
        ...scopes[workspaceKey],
        entries: { 'workspace-greeting': { disabled: false, config: { fail: true } } },
      },
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /workspace-greeting: Scoped setup failed/);
  assert.ok(names(child.id).includes('scoped_greeting'));
  const removed = await request('/workspaces/' + parent.workspaceId, 'DELETE');
  assert.equal(removed.status, 200);
  assert.ok(removed.body.deleted.includes(created.body.id));
  assert.equal(readFileSync(cleaned, 'utf8'), 'released\nreleased\n');
  assert.deepEqual((await request('/settings')).body.scopes, {});
  assert.equal(existsSync(instance), false);
  assert.equal((await request(operation(workspaceKey), 'POST', {})).status, 404);
  assert.ok(names(outside.id).includes('read'));
});

test('read-only permissions are bound to the selected tool registration', async (t) => {
  const { app, mock, paths, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'replacement',
    { scope: 'session' },
    `
export const inject = ["harnessTools"];
export const apply = (ctx) => {
      for (const name of ['read', 'custom']) ctx.effect(() => ctx.harnessTools.register({
        name, description: 'replacement', parameters: { type: 'object' },
        async execute() { return { content: [{ type: 'text', text: 'Authorized local read' }] }; }
      }, { access: 'readOnly' }));
    };
`,
  );
  const { plugins } = app.runtime;
  const registry = plugins.ctx.harnessRegistry;
  const parent = registry.create({ permission: 'readOnly' });
  const child = registry.create({ parentId: parent.id, permission: 'fullAccess' });
  const list = (id: string) => plugins.ctx.harnessTools.forSession(id);
  const original = expectPresent(
    list(child.id).find(({ name }) => name === 'read'),
    'inherited read tool',
  );
  assert.ok(list(child.id).some(({ name }) => name === 'load_skill'));
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        scopes: { ['session:' + child.id]: { entries: { replacement: { disabled: false } } } },
      })
    ).status,
    200,
  );
  await plugins.prepare(`session:${child.id}`);
  assert.equal(
    list(child.id).some(({ name }) => name === 'read' || name === 'custom'),
    false,
  );
  assert.ok(list(parent.id).some(({ name }) => name === 'read'));
  await assert.rejects(original.execute('old', { path: 'README.md' }), /Tool denied/);
  await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Continue');
  const sent = expectPresent(mock.requests.at(-1), 'request with tools');
  assert.equal(JSON.stringify(sent.tools).includes('"name":"read"'), false);
  assert.equal(JSON.stringify(sent.tools).includes('"name":"load_skill"'), true);
  assert.deepEqual((await request('/permissions/plugins/replacement')).body.tools, ['custom', 'read']);
  assert.equal(
    (await request('/permissions/plugins/replacement', 'PATCH', { tool: 'unknown', allowed: true })).status,
    400,
  );
  assert.equal(
    (await request('/permissions/plugins/replacement', 'PATCH', { tool: 'custom', allowed: true })).status,
    200,
  );
  const granted = expectPresent(
    list(child.id).find(({ name }) => name === 'custom'),
    'granted registration',
  );
  assert.match(JSON.stringify(await granted.execute('granted', {})), /Authorized local read/);
  assert.ok(!list(child.id).some(({ name }) => name === 'read'));
  assert.equal(
    (await request('/permissions/plugins/replacement', 'PATCH', { tool: 'custom', allowed: false })).status,
    200,
  );
  await assert.rejects(granted.execute('revoked', {}), /Tool denied/);
});

test('explicit Profile composition can replace the default tool policy without a provider whitelist', async (t) => {
  const { app, paths, request } = await fixture(t);
  writePlugin(paths.plugins, 'deny-tools', {}, `
export const provide = ['harnessToolPolicy'];
export function apply(ctx) {
  ctx.provide('harnessToolPolicy', () => false);
}
`);
  const root = app.runtime.plugins.ctx;
  const session = root.harnessRegistry.create();
  assert.ok(root.harnessTools.forSession(session.id).some(({ name }) => name === 'read'));
  const duplicate = await request('/settings', 'PATCH', { entries: { 'deny-tools': { disabled: false } } });
  assert.notEqual(duplicate.status, 200);
  const replacement = await request('/settings', 'PATCH', {
    entries: { 'core:tool-policy': { disabled: true }, 'deny-tools': { disabled: false } },
  });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  assert.deepEqual(root.harnessTools.forSession(session.id), []);
  const restored = await request('/settings', 'PATCH', {
    entries: { 'core:tool-policy': { disabled: false }, 'deny-tools': { disabled: true } },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.ok(root.harnessTools.forSession(session.id).some(({ name }) => name === 'read'));
});

test('file tools and HTTP preview consume the same selected File Access provider', async (t) => {
  const { app, paths, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'virtual-files',
    {},
    `
export const provide = ["harnessFileAccess"];
export function apply(ctx) {
      const data = Buffer.from('Provided file content');
      ctx.provide('harnessFileAccess', { open: () => ({
        access: async () => {},
        readFile: async () => data,
        stat: async () => ({ size: data.length, isDirectory: () => false }),
        imageType: async () => null,
        async *chunks() { yield data; }
      }) });
    }
`,
  );
  const selection = { entries: { 'core:file-access': { disabled: true }, 'virtual-files': { disabled: false } } };
  assert.equal((await request('/settings', 'PATCH', selection)).status, 200);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  const preview = await request('/workspaces/' + session.workspaceId + '/files/preview?path=virtual.txt');
  assert.equal(preview.body.text, 'Provided file content');
  const tool = expectPresent(
    app.runtime.plugins.ctx.harnessTools.forSession(session.id).find(({ name }) => name === 'read'),
    'read tool',
  );
  assert.match(
    JSON.stringify(
      (await tool.execute('virtual', { path: 'virtual.txt' }, undefined, undefined, undefined)).content,
    ),
    /Provided file content/,
  );
});

test('native runs use the nearest scoped LLM provider while siblings retain the application adapter', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(
    paths.plugins,
    'scoped-llm',
    { scope: 'session' },
    `
export const provide = ["harnessLlm"];
export const apply = (ctx, config) => { ctx.provide('harnessLlm', {
      async *stream(request) {
        request.signal.throwIfAborted();
        yield { type: 'text-delta', text: config.answer };
        yield { type: 'done', message: { role: 'assistant', timestamp: Date.now(),
          content: [{ type: 'text', text: config.answer }], stopReason: 'stop' } };
      }
    }); };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const scope = (answer: string) => ({
    entries: { 'scoped-llm': { disabled: false, config: { answer } } },
  });
  const scopes = {
    ['session:' + parent.id]: scope('Parent adapter'),
    ['session:' + child.id]: scope('Child adapter'),
  };
  const configured = await request('/settings', 'PATCH', { scopes });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Parent task'), 'Parent adapter');
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Child task'), 'Child adapter');
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(sibling.id, 'Sibling task'), 'Mock response');
  assert.equal(mock.requests.length, 1);
  assert.strictEqual(
    app.runtime.plugins.require(`session:${child.id}`, 'harnessModels'),
    app.runtime.plugins.ctx.harnessModels,
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        scopes: {
          ['session:' + parent.id]: scopes['session:' + parent.id],
          ['session:' + child.id]: { disabledTools: ['sandbox_shell'] },
        },
      })
    ).status,
    200,
  );
  assert.equal(
    await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Use inherited adapter'),
    'Parent adapter',
  );
  assert.equal(mock.requests.length, 1);
});

test('native file and shell tools use scoped file, process and sandbox services without changing siblings', async (t) => {
  const { app, paths, request } = await fixture(t, ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model input');
    return last.role === 'tool'
      ? 'Completed'
      : last.content.startsWith('read')
        ? { tool: 'read', args: { path: 'note.txt' } }
        : { tool: 'sandbox_shell', args: { command: 'requested command' } };
  });
  writeFileSync(join(paths.cwd, 'note.txt'), 'application file');
  const isolated = (output: string) => `({ async prepare(request) {
    return { file: process.execPath, args: ['-e', ${JSON.stringify('process.stdout.write(' + JSON.stringify(output) + ')')}],
      cwd: request.cwd, env: {} };
  } })`;
  writePlugin(
    paths.plugins,
    'application-sandbox',
    {},
    `
export const provide = ["harnessSandbox"];
export const apply = (ctx) => { ctx.provide('harnessSandbox', ${isolated('application sandbox')}); };
`,
  );
  writePlugin(
    paths.plugins,
    'scoped-environment',
    { scope: 'session' },
    `
export const provide = ["harnessFileAccess","harnessSandbox"];
export const apply = (ctx) => {
      ctx.provide('harnessFileAccess', { open: () => ({
        access: async () => {}, stat: async () => ({ isDirectory: () => false }),
        imageType: async () => null,
        readFile: async () => Buffer.from('scoped file'),
        async *chunks() { yield Buffer.from('scoped file'); }
      }) });
      ctx.provide('harnessSandbox', ${isolated('scoped sandbox')});
    };
`,
  );
  writePlugin(
    paths.plugins,
    'scoped-process',
    { scope: 'session' },
    `
export const provide = ["harnessProcess"];
export const apply = (ctx) => { ctx.provide('harnessProcess', {
      async run(request) {
        if (!request.sessionId) throw new Error('Missing execution scope');
        return { code: 0, signal: null, stdout: 'scoped process', stderr: '', truncated: false };
      }
    }); };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const configured = await request('/settings', 'PATCH', {
    entries: { shell: { disabled: false, config: { mode: 'isolated' } }, 'core:sandbox': { disabled: true }, 'application-sandbox': { disabled: false } },

    scopes: {
      ['session:' + parent.id]: {
        entries: { 'scoped-environment': { disabled: false } },

      },
      ['session:' + child.id]: {
        entries: { 'scoped-process': { disabled: false } },

      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const preview = (id: string) =>
    request('/workspaces/' + parent.workspaceId + '/files/preview?path=note.txt&sessionId=' + id);
  assert.equal(
    (await preview(parent.id)).body.text,
    'scoped file',
    'HTTP inspection prepares the lazy scope',
  );
  assert.equal((await preview(sibling.id)).body.text, 'application file');
  const lastTool = (id: string) =>
    expectPresent(
      app.runtime.plugins.ctx.harnessRegistry
        .log(id)
        .projection()
        .messages.filter(({ role }) => role === 'toolResult')
        .at(-1),
      'tool result',
    );
  await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'read in inherited scope');
  assert.match(JSON.stringify(lastTool(child.id).content), /scoped file/);
  await app.runtime.plugins.ctx.harnessRuns.send(sibling.id, 'read in sibling');
  assert.match(JSON.stringify(lastTool(sibling.id).content), /application file/);
  for (const [id, expected] of [
    [parent.id, 'scoped sandbox'],
    [child.id, 'scoped process'],
    [sibling.id, 'application sandbox'],
  ]) {
    const running = app.runtime.plugins.ctx.harnessRuns.send(id, 'shell execution');
    const pending = await waitUntil(
      () => request('/approvals'),
      ({ body }) => body.some((item: { sessionId: string }) => item.sessionId === id),
    );
    const approval = expectPresent(
      pending.body.find((item: { sessionId: string }) => item.sessionId === id),
      'pending approval',
    );
    assert.equal((await request('/approvals', 'POST', { id: approval.id, allow: true })).status, 200);
    await running;
    assert.equal(lastTool(id).isError, false);
    assert.match(JSON.stringify(lastTool(id).content), new RegExp(expected));
  }
});

test('scoped model catalogs govern explicit runs and inherited or model-selected delegation without changing siblings', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(
    paths.plugins,
    'scoped-models',
    { scope: 'session' },
    `
export const provide = ["harnessModels","harnessLlm"];
export const apply = (ctx) => {
      const provider = 'scoped-only';
      const ids = ['parent-model', 'child-model'];
      const resolve = (choice) => {
        const id = choice?.id || ids[0];
        if (choice?.provider !== provider || !ids.includes(id)) return undefined;
        return { provider, id };
      };
      const list = () => ids.map(id => ({ provider, id, name: id, configured: true, thinkingLevels: ['off'] }));
      ctx.provide('harnessModels', {
        list, available: async () => list(), resolve,
        capabilities(choice) {
          const model = resolve(choice);
          return { id: model.id, name: model.id, input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false };
        }
      });
      ctx.provide('harnessLlm', {
        async *stream(request) {
          request.signal.throwIfAborted();
          const model = resolve(request.model);
          const last = request.messages.at(-1);
          const text = typeof last.content === 'string' ? last.content : last.content.filter(part => part.type === 'text').map(part => part.text).join('');
          if (last.role === 'user' && (text === 'Delegate inherited' || text === 'Delegate explicit')) {
            if (!request.tools.some(tool => tool.name === 'delegate')) throw new Error('Delegation tool unavailable');
            const explicit = text === 'Delegate explicit';
            yield { type: 'done', message: { role: 'assistant', provider, model: model.id, timestamp: Date.now(), stopReason: 'toolUse',
              content: [{ type: 'toolCall', id: request.sessionId + (explicit ? '-explicit' : '-inherited'), name: 'delegate',
                arguments: { task: explicit ? 'Explicit child task' : 'Inherited child task', ...(explicit ? { provider, model: 'child-model' } : {}) } }] } };
          } else {
            const answer = 'Scoped ' + model.id;
            yield { type: 'text-delta', text: answer };
            yield { type: 'done', message: { role: 'assistant', provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
              content: [{ type: 'text', text: answer }] } };
          }
        }
      });
    };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const scopedChoice = { provider: 'scoped-only', id: 'parent-model' };
  const applicationChoice = { ...app.runtime.plugins.ctx.harnessModelPreference.recent() };
  assert.equal(app.runtime.plugins.ctx.harnessModels.resolve(scopedChoice), undefined);
  const configured = await request('/settings', 'PATCH', {
    scopes: {
      ['session:' + parent.id]: {
        entries: { 'scoped-models': { disabled: false } },

      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  assert.equal(
    await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Delegate inherited', undefined, {
      model: scopedChoice,
    }),
    'Scoped parent-model',
  );
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(
    await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Delegate explicit', undefined, {
      model: scopedChoice,
    }),
    'Scoped parent-model',
  );
  assert.equal(
    await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Continue without an explicit model'),
    'Scoped parent-model',
  );
  const children = app.runtime.plugins.ctx.harnessRegistry
    .list()
    .filter(({ parentId }) => parentId === parent.id);
  assert.equal(children.length, 2);
  const inherited = children.find(({ title }) => title === 'Inherited child task');
  const explicit = children.find(({ title }) => title === 'Explicit child task');
  assert.ok(inherited);
  assert.ok(explicit);
  assert.deepEqual(
    app.runtime.plugins.ctx.harnessRegistry.log(inherited.id).projection().model,
    scopedChoice,
  );
  assert.deepEqual(app.runtime.plugins.ctx.harnessRegistry.log(explicit.id).projection().model, {
    provider: 'scoped-only',
    id: 'child-model',
  });
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(inherited.id)?.state, 'completed');
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(explicit.id)?.state, 'completed');
  assert.ok(
    app.runtime.plugins.ctx.harnessRegistry
      .log(parent.id)
      .projection()
      .messages.filter(({ role }) => role === 'toolResult')
      .every(({ isError }) => !isError),
  );
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(
    await app.runtime.plugins.ctx.harnessRuns.send(sibling.id, 'Use the application model'),
    'Mock response',
  );
  assert.deepEqual(
    app.runtime.plugins.ctx.harnessRegistry.log(sibling.id).projection().model,
    applicationChoice,
  );
  assert.equal(mock.requests.length, 1);
});

test('a replacement Agent receives a scoped run Fiber and releases its resources on success and failure', async (t) => {
  const { app, paths, request } = await fixture(t);
  const file = join(paths.plugins, 'agent-lifetime.log');
  writePlugin(paths.plugins, 'custom-agent', { scope: 'session' }, `
import { appendFileSync } from 'node:fs';
export const provide = ['harnessAgent', 'agentMarker'];
export function apply(ctx) {
  ctx.provide('agentMarker', 'session service');
  ctx.provide('harnessAgent', {
    async prompt(run, record, text) {
      if (run.fiber === ctx.fiber || run.get('agentMarker') !== 'session service')
        throw new Error('Missing isolated run context');
      run.effect(() => () => appendFileSync(${JSON.stringify(file)}, text + '\\n'));
      if (text === 'fail') throw new Error('Expected custom agent failure');
      return 'Custom answer';
    },
  });
}
`);
  const root = app.runtime.plugins.ctx;
  const session = root.harnessRegistry.create();
  const sibling = root.harnessRegistry.create();
  const configured = await request('/settings', 'PATCH', {
    scopes: { ['session:' + session.id]: { entries: { 'custom-agent': { disabled: false } } } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(await root.harnessRuns.send(session.id, 'success'), 'Custom answer');
  assert.equal(readFileSync(file, 'utf8'), 'success\n');
  await assert.rejects(root.harnessRuns.send(session.id, 'fail'), /Expected custom agent failure/);
  assert.equal(readFileSync(file, 'utf8'), 'success\nfail\n');
  assert.notEqual(await root.harnessRuns.send(sibling.id, 'Default loop'), 'Custom answer');
});


test('Agent setup owns temporary tools and prompt sections and isolates sibling runs', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  writePlugin(paths.plugins, 'run-capabilities', {}, `
export function apply(ctx) {
  ctx.on('agent/setup', (run, id) => {
    const tools = run.get('harnessTools');
    const prompt = run.get('harnessPrompt');
    if (!tools || !prompt) throw new Error('Missing run services');
    run.effect(() => tools.register({
      name: 'run_marker',
      description: 'A run-local tool',
      parameters: { type: 'object', properties: {} },
      async execute() { return { content: [{ type: 'text', text: id }] }; }
    }));
    run.effect(() => prompt.register({ id: 'run-marker', render: () => 'Run marker ' + id }));
  });
}
`);
  const configured = await request('/settings', 'PATCH', { entries: { 'run-capabilities': { disabled: false } } });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const root = app.runtime.plugins.ctx;
  const first = root.harnessRegistry.create();
  const second = root.harnessRegistry.create();
  await root.harnessRuns.send(first.id, 'First run');
  assert.ok(!root.harnessTools.forSession(first.id).some(({ name }) => name === 'run_marker'));
  await root.harnessRuns.send(second.id, 'Second run');
  assert.match(JSON.stringify(mock.requests[0]), new RegExp('Run marker ' + first.id));
  assert.match(JSON.stringify(mock.requests[1]), new RegExp('Run marker ' + second.id));
  assert.doesNotMatch(JSON.stringify(mock.requests[1]), new RegExp('Run marker ' + first.id));
});
