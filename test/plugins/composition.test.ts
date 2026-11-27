import { sendRun } from '../support/runs.ts';
import { runTool } from '@mini-harness/tools/execution';
import { isViewMessage } from '@mini-harness/sessions/message';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { writePlugin } from '../support/plugin-fixture.ts';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from '../support/api-fixture.ts';

const examples = fileURLToPath(new URL('../../docs/examples/', import.meta.url));
function copyExample(directory: string, id: string) {
  cpSync(join(examples, id), join(directory, id), { recursive: true });
}
test('external services and their declared consumers compose through Cordis service ownership', async (t) => {
  const { paths, request } = await fixture(t);
  copyExample(paths.plugins, 'greeting-route');
  copyExample(paths.plugins, 'greeting-service');
  const patch = (data: unknown) => request('/settings', 'PATCH', data);
  const endpoint = '/greeting/hello/Harness';
  assert.equal(
    (
      await patch({
        entries: { 'greeting-route': { name: '../../plugins/greeting-route', disabled: false } },
      })
    ).status,
    200,
  );
  assert.equal((await request(endpoint)).status, 404);
  assert.equal(
    (
      await patch({
        entries: {
          'greeting-route': { name: '../../plugins/greeting-route', disabled: false },
          'greeting-service': { name: '../../plugins/greeting-service', disabled: false },
        },
      })
    ).status,
    200,
  );
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness');
  writePlugin(
    paths.plugins,
    'suffix',
    {},
    "export const provide = [\"exampleSuffix\"];\nexport const apply = (ctx) => { ctx.provide('exampleSuffix', '!'); };",
  );
  assert.equal(
    (await patch({ entries: { suffix: { name: '../../plugins/suffix', disabled: false } } })).status,
    200,
  );
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');

  writePlugin(
    paths.plugins,
    'greeting-alt',
    {},
    "export const provide = [\"exampleGreeting\"];\nexport const apply = (ctx) => { ctx.provide('exampleGreeting', { greet: (name) => 'Welcome, ' + name }); };",
  );
  assert.match(
    (await patch({ entries: { 'greeting-alt': { name: '../../plugins/greeting-alt', disabled: false } } }))
      .body.error,
    /has been registered/,
  );
  assert.equal(
    (
      await patch({
        entries: {
          'greeting-service': { name: '../../plugins/greeting-service', disabled: true },
          'greeting-alt': { name: '../../plugins/greeting-alt', disabled: false },
        },
      })
    ).status,
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
  assert.equal(
    (
      await patch({
        entries: {
          'greeting-alt': { name: '../../plugins/greeting-alt', disabled: true },
          'greeting-service': { name: '../../plugins/greeting-service', disabled: false },
        },
      })
    ).status,
    200,
  );
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');
});

test('Shell delegates to a selected external process provider without approval', async (t) => {
  const { paths, app, request } = await fixture(t);
  copyExample(paths.plugins, 'process-preview');
  const result = await request('/settings', 'PATCH', {
    entries: {
      shell: { disabled: false },
      'core:process': { disabled: true },
      'process-preview': { name: '../../plugins/process-preview', disabled: false },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { id } = app.runtime.plugins.ctx.harnessSessions.create();
  const tool = expectPresent(
    app.runtime.plugins.ctx.harnessTools
      .list({ resourceId: id, scope: app.runtime.plugins.ctx.harnessSessions.runScope(id) })
      .find(({ name }) => name === 'shell'),
    'shell tool',
  );
  const execution = runTool(tool, 'preview', {
    command: 'Preview command',
  });
  const response = await execution;
  assert.deepEqual((await request('/approvals')).body, []);
  assert.match(JSON.stringify(response.content), /Preview command/);
});

test('scoped plugins inherit services and contributions and release their own resources', async (t) => {
  const { app, paths, root, request, mock } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Finished greeting' : { tool: 'scoped_greeting', args: {} },
  );
  copyExample(paths.plugins, 'scoped-tool');
  const cleaned = join(root, 'released');
  writePlugin(
    paths.plugins,
    'workspace-greeting',
    {},
    `
export const provide = ["exampleGreeting"];
export const inject = ["harnessSessions","harnessWorkspaces","harnessRoutes","harnessPluginData","harnessPluginChanges","harnessTools"];
import { scopeOf } from 'mini-harness/scopes';
import { appendFileSync } from 'node:fs';
export const apply = (ctx, config) => {
      if (config.fail) throw new Error('Scoped setup failed');
      ctx.effect(() => () => appendFileSync(${JSON.stringify(cleaned)}, 'released\\n'));
      const workspaces = ctx.harnessWorkspaces;
      const workspaceId = workspaces.list().find(({ id }) => workspaces.scope(id) === scopeOf(ctx)).id;
      ctx.provide('exampleGreeting', { greet: (name) => workspaceId + ':' + name });
      const sessions = ctx.harnessSessions;
      const prefix = '/api/workspace-greeting/' + workspaceId;
      ctx.effect(() => ctx.harnessRoutes.register('POST', prefix + '/start', () => sessions.create({ title: 'Scoped root', workspaceId })));
      ctx.effect(() => ctx.harnessRoutes.register('POST', prefix + '/tools', async ({ body }) => {
        const { input: id } = await body();
        return ctx.harnessTools.list({ resourceId: id, scope: sessions.runScope(id) }).map(({ name }) => name);
      }));
      ctx.effect(() => ctx.harnessRoutes.register('POST', prefix + '/lookup', async ({ body }) => sessions.get((await body()).input)));
      ctx.effect(() => ctx.harnessRoutes.register('POST', prefix + '/greet', async ({ body }) => {
        const { input } = await body();
        ctx.harnessPluginData.write('seen', input);
        ctx.harnessPluginChanges.invalidate();
        return { workspaceId, input };
      }));
    };
`,
  );
  const secondWorkspace = join(root, 'other');
  mkdirSync(secondWorkspace);
  const workspace = (await request('/workspaces', 'POST', { path: secondWorkspace })).body;
  const parent = app.runtime.plugins.ctx.harnessSessions.create();
  const child = app.runtime.plugins.ctx.harnessSessions.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessSessions.create();
  const outside = app.runtime.plugins.ctx.harnessSessions.create({ workspaceId: workspace.id });
  const workspaceKey = 'workspace:' + parent.workspaceId;
  const sessionKey = 'session:' + parent.id;
  const scopes = {
    [workspaceKey]: {
      isolate: ['exampleGreeting'],
      entries: { 'workspace-greeting': { name: '../../plugins/workspace-greeting', disabled: false } },
    },
    [sessionKey]: {
      entries: { 'scoped-tool': { name: '../../plugins/scoped-tool', disabled: false } },
    },
  };
  const enabled = await request('/settings', 'PATCH', { scopes });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  const catalog = await request('/plugins', 'GET');
  assert.equal(catalog.status, 200);
  assert.ok(
    !catalog.body.some(({ id }: { id: string }) => id === 'workspace-greeting' || id === 'scoped-tool'),
  );
  assert.equal(existsSync(cleaned), false);
  const operation = (key: string, action = 'greet') =>
    '/workspace-greeting/' + key.slice('workspace:'.length) + '/' + action;
  const created = await request(operation(workspaceKey, 'start'), 'POST', {});
  assert.equal(created.status, 200);
  assert.equal(created.body.parentId, null);
  assert.equal(created.body.workspaceId, parent.workspaceId);
  assert.equal(
    (await request(operation(workspaceKey, 'lookup'), 'POST', { input: outside.id })).body.id,
    outside.id,
  );
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
  const names = (id: string) =>
    tools
      .list({ resourceId: id, scope: app.runtime.plugins.ctx.harnessSessions.runScope(id) })
      .map(({ name }) => name);
  assert.ok(names(parent.id).includes('scoped_greeting'));
  assert.ok(
    (await request(operation(workspaceKey, 'tools'), 'POST', { input: parent.id })).body.includes(
      'scoped_greeting',
    ),
  );
  assert.ok(
    (await request(operation(workspaceKey, 'tools'), 'POST', { input: outside.id })).body.includes('read'),
  );
  assert.ok(names(child.id).includes('scoped_greeting'));
  assert.ok(names(child.id).includes('read'));
  for (const id of [sibling.id, outside.id]) {
    assert.ok(!names(id).includes('scoped_greeting'));
    assert.ok(names(id).includes('read'));
  }
  const tool = expectPresent(
    tools
      .list({ resourceId: child.id, scope: app.runtime.plugins.ctx.harnessSessions.runScope(child.id) })
      .find(({ name }) => name === 'scoped_greeting'),
    'scoped greeting tool',
  );
  assert.match(JSON.stringify(await runTool(tool, 'scope', {})), new RegExp(parent.id));
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'Run scoped greeting'),
    'Finished greeting',
  );
  const saved = (await request('/sessions/' + parent.id)).body;
  assert.equal(
    expectPresent(
      saved.timeline.find(
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
        entries: {
          'workspace-greeting': {
            name: '../../plugins/workspace-greeting',
            disabled: false,
            config: { fail: true },
          },
        },
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

test('read-only tool declarations follow the same policy for every plugin', async (t) => {
  const { app, mock, paths, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'replacement',
    {},
    `
export const inject = ["harnessTools"];
export const apply = (ctx) => {
      for (const name of ['read', 'custom', 'write_like']) ctx.effect(() => ctx.harnessTools.register({
        name, tags: name === 'write_like' ? [] : ['readOnly'], description: 'replacement', parameters: { type: 'object' },
        async execute() { return { content: [{ type: 'text', text: 'Authorized local read' }] }; }
      }));
    };
`,
  );
  const { plugins } = app.runtime;
  const registry = plugins.ctx.harnessSessions;
  const parent = registry.create({ permission: 'readOnly' });
  const child = registry.create({ parentId: parent.id, permission: 'fullAccess' });
  const list = (id: string) =>
    plugins.ctx.harnessTools.list({ resourceId: id, scope: registry.runScope(id) });
  const original = expectPresent(
    list(child.id).find(({ name }) => name === 'read'),
    'inherited read tool',
  );
  assert.ok(list(child.id).some(({ name }) => name === 'load_skill'));
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        scopes: {
          ['session:' + child.id]: {
            entries: { replacement: { name: '../../plugins/replacement', disabled: false } },
          },
        },
      })
    ).status,
    200,
  );
  await plugins.prepare(`session:${child.id}`);
  assert.throws(() => runTool(original, 'old', { path: 'README.md' }), /no longer available/);
  await sendRun(app.runtime.plugins.ctx.harnessRuns, child.id, 'Continue');
  const sent = expectPresent(mock.requests.at(-1), 'request with tools');
  assert.equal(JSON.stringify(sent.tools).includes('"name":"read"'), true);
  assert.equal(JSON.stringify(sent.tools).includes('"name":"custom"'), true);
  assert.equal(JSON.stringify(sent.tools).includes('"name":"write_like"'), false);
  assert.equal(JSON.stringify(sent.tools).includes('"name":"load_skill"'), true);
  const custom = expectPresent(
    list(child.id).find(({ name }) => name === 'custom'),
    'read-only registration',
  );
  assert.match(JSON.stringify(await runTool(custom, 'read', {})), /Authorized local read/);
});

test('explicit Profile composition can replace the default tool policy without a provider whitelist', async (t) => {
  const { app, mock, paths, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'deny-tools',
    {},
    `
export const provide = ['harnessToolPolicy'];
export function apply(ctx) {
  ctx.provide('harnessToolPolicy', () => false);
}
`,
  );
  const root = app.runtime.plugins.ctx;
  const session = root.harnessSessions.create();
  const advertised = async () => {
    await sendRun(root.harnessRuns, session.id, 'Inspect available tools');
    return JSON.stringify(mock.requests.at(-1)?.tools ?? []);
  };
  assert.match(await advertised(), /"name":"read"/);
  const duplicate = await request('/settings', 'PATCH', {
    entries: { 'deny-tools': { name: '../../plugins/deny-tools', disabled: false } },
  });
  assert.notEqual(duplicate.status, 200);
  const replacement = await request('/settings', 'PATCH', {
    entries: {
      'core:tool-policy': { disabled: true },
      'deny-tools': { name: '../../plugins/deny-tools', disabled: false },
    },
  });
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  assert.equal(await advertised(), '[]');
  assert.ok(
    root.harnessTools
      .list({ resourceId: session.id, scope: root.harnessSessions.runScope(session.id) })
      .some(({ name }) => name === 'read'),
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { 'deny-tools': { disabled: true } },
      })
    ).status,
    200,
  );
  assert.match(await advertised(), /"name":"read"/);
  const restored = await request('/settings', 'PATCH', {
    entries: {
      'core:tool-policy': { disabled: false },
      'deny-tools': { name: '../../plugins/deny-tools', disabled: true },
    },
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  assert.match(await advertised(), /"name":"read"/);
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
        async *chunks() { yield data; }
      }) });
    }
`,
  );
  const selection = {
    entries: {
      'core:file-access': { disabled: true },
      'virtual-files': { name: '../../plugins/virtual-files', disabled: false },
    },
  };
  assert.equal((await request('/settings', 'PATCH', selection)).status, 200);
  const session = app.runtime.plugins.ctx.harnessSessions.create();
  const preview = await request('/workspaces/' + session.workspaceId + '/files/preview?path=virtual.txt');
  assert.equal(preview.body.text, 'Provided file content');
  const tool = expectPresent(
    app.runtime.plugins.ctx.harnessTools
      .list({ resourceId: session.id, scope: app.runtime.plugins.ctx.harnessSessions.runScope(session.id) })
      .find(({ name }) => name === 'read'),
    'read tool',
  );
  assert.match(
    JSON.stringify((await runTool(tool, 'virtual', { path: 'virtual.txt' })).content),
    /Provided file content/,
  );
});

test('native runs use the nearest scoped LLM provider while siblings retain the application adapter', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(
    paths.plugins,
    'scoped-llm',
    {},
    `
export const inject = ["harnessLlm"];
export const apply = (ctx, config) => { ctx.effect(() => ctx.harnessLlm.register({
      accepts: ({ provider }) => provider === 'local-mock',
      async *stream(request) {
        request.signal.throwIfAborted();
        yield { type: 'text-delta', text: config.answer };
        yield { type: 'done', message: { role: 'assistant', timestamp: Date.now(),
          content: [{ type: 'text', text: config.answer }], stopReason: 'stop' } };
      }
    })); };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessSessions.create();
  const child = app.runtime.plugins.ctx.harnessSessions.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessSessions.create();
  const scope = (answer: string) => ({
    entries: { 'scoped-llm': { name: '../../plugins/scoped-llm', disabled: false, config: { answer } } },
  });
  const scopes = {
    ['session:' + parent.id]: scope('Parent adapter'),
    ['session:' + child.id]: scope('Child adapter'),
  };
  const configured = await request('/settings', 'PATCH', { scopes });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'Parent task'),
    'Parent adapter',
  );
  assert.equal(await sendRun(app.runtime.plugins.ctx.harnessRuns, child.id, 'Child task'), 'Child adapter');
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, sibling.id, 'Sibling task'),
    'Mock response',
  );
  assert.equal(mock.requests.length, 1);
  assert.deepEqual(
    app.runtime.plugins.context(`session:${child.id}`).harnessModels.list(),
    app.runtime.plugins.ctx.harnessModels.list(),
  );
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        scopes: {
          ['session:' + parent.id]: scopes['session:' + parent.id],
          ['session:' + child.id]: {},
        },
      })
    ).status,
    200,
  );
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, child.id, 'Use inherited adapter'),
    'Parent adapter',
  );
  assert.equal(mock.requests.length, 1);
});

test('native file and shell tools use scoped file and process services without changing siblings', async (t) => {
  const { app, paths, request } = await fixture(t, ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model input');
    if (last.content.startsWith('[agent ')) return 'Observed child update';
    return last.role === 'tool'
      ? 'Completed'
      : last.content.startsWith('read')
        ? { tool: 'read', args: { path: 'note.txt' } }
        : { tool: 'shell', args: { command: 'requested command' } };
  });
  writeFileSync(join(paths.cwd, 'note.txt'), 'application file');
  const processProvider = (output: string) => `({ start(request) {
    if (!request.file) throw new Error('Missing executable');
    return {
      stdin: new PassThrough(),
      stdout: Readable.from([Buffer.from(${JSON.stringify(output)})]),
      stderr: Readable.from([]),
      finished: Promise.resolve({ code: 0, signal: null }),
    };
  } })`;
  writePlugin(
    paths.plugins,
    'application-process',
    {},
    `
import { PassThrough, Readable } from "node:stream";
export const provide = ["harnessProcess"];
export const apply = (ctx) => { ctx.provide('harnessProcess', ${processProvider('application process')}); };
`,
  );
  writePlugin(
    paths.plugins,
    'scoped-environment',
    {},
    `
import { PassThrough, Readable } from "node:stream";
export const provide = ["harnessFileAccess","harnessProcess"];
export const apply = (ctx) => {
      ctx.provide('harnessFileAccess', { open: () => ({
        access: async () => {}, stat: async () => ({ isDirectory: () => false }),
        readFile: async () => Buffer.from('scoped file'),
        async *chunks() { yield Buffer.from('scoped file'); }
      }) });
      ctx.provide('harnessProcess', ${processProvider('parent process')});
    };
`,
  );
  writePlugin(
    paths.plugins,
    'scoped-process',
    {},
    `
import { PassThrough, Readable } from "node:stream";
export const provide = ["harnessProcess"];
export const apply = (ctx) => { ctx.provide('harnessProcess', {
      start(request) {
        if (!request.file) throw new Error('Missing executable');
        return {
          stdin: new PassThrough(),
          stdout: Readable.from([Buffer.from('scoped process')]),
          stderr: Readable.from([]),
          finished: Promise.resolve({ code: 0, signal: null }),
        };
      }
    }); };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessSessions.create();
  const child = app.runtime.plugins.ctx.harnessSessions.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessSessions.create();
  const configured = await request('/settings', 'PATCH', {
    entries: {
      shell: { disabled: false },
      'core:process': { disabled: true },
      'application-process': { name: '../../plugins/application-process', disabled: false },
    },

    scopes: {
      ['session:' + parent.id]: {
        isolate: ['harnessFileAccess', 'harnessProcess'],
        entries: { 'scoped-environment': { name: '../../plugins/scoped-environment', disabled: false } },
      },
      ['session:' + child.id]: {
        isolate: ['harnessProcess'],
        entries: { 'scoped-process': { name: '../../plugins/scoped-process', disabled: false } },
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
      app.runtime.plugins.ctx.harnessSessions
        .log(id)
        .projection()
        .timeline.filter(isViewMessage)
        .filter(({ role }) => role === 'toolResult')
        .at(-1),
      'tool result',
    );
  await sendRun(app.runtime.plugins.ctx.harnessRuns, child.id, 'read in inherited scope');
  assert.match(JSON.stringify(lastTool(child.id).content), /scoped file/);
  await sendRun(app.runtime.plugins.ctx.harnessRuns, sibling.id, 'read in sibling');
  assert.match(JSON.stringify(lastTool(sibling.id).content), /application file/);
  for (const [id, expected] of [
    [parent.id, 'parent process'],
    [child.id, 'scoped process'],
    [sibling.id, 'application process'],
  ]) {
    await sendRun(app.runtime.plugins.ctx.harnessRuns, id, 'shell execution');
    assert.deepEqual((await request('/approvals')).body, []);
    assert.equal(lastTool(id).isError, false);
    assert.match(JSON.stringify(lastTool(id).content), new RegExp(expected));
  }
});

test('scoped model catalogs govern explicit runs and inherited or model-selected delegation without changing siblings', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(
    paths.plugins,
    'scoped-models',
    {},
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
      const adapter = {
        accepts: (choice) => Boolean(resolve(choice)),
        async *stream(request) {
          request.signal.throwIfAborted();
          const model = resolve(request.model);
          const last = request.messages.at(-1);
          const text = typeof last.content === 'string' ? last.content : last.content.filter(part => part.type === 'text').map(part => part.text).join('');
          if (last.role === 'user' && (text === 'Delegate inherited' || text === 'Delegate explicit')) {
            if (!request.tools.some(tool => tool.name === 'delegate')) throw new Error('Delegation tool unavailable');
            const explicit = text === 'Delegate explicit';
            yield { type: 'done', message: { role: 'assistant', provider, model: model.id, timestamp: Date.now(), stopReason: 'toolUse',
              content: [{ type: 'toolCall', id: explicit ? 'delegate-explicit' : 'delegate-inherited', name: 'delegate',
                arguments: { task: explicit ? 'Explicit child task' : 'Inherited child task', ...(explicit ? { provider, model: 'child-model' } : {}) } }] } };
          } else {
            const answer = 'Scoped ' + model.id;
            yield { type: 'text-delta', text: answer };
            yield { type: 'done', message: { role: 'assistant', provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
              content: [{ type: 'text', text: answer }] } };
          }
        }
      };
      ctx.provide('harnessLlm', { ...adapter, select: () => adapter });
    };
`,
  );
  const parent = app.runtime.plugins.ctx.harnessSessions.create();
  const sibling = app.runtime.plugins.ctx.harnessSessions.create();
  const scopedChoice = { provider: 'scoped-only', id: 'parent-model' };
  const applicationChoice = { ...app.runtime.plugins.ctx.harnessModelPreference.recent() };
  assert.equal(app.runtime.plugins.ctx.harnessModels.resolve(scopedChoice), undefined);
  const configured = await request('/settings', 'PATCH', {
    scopes: {
      ['session:' + parent.id]: {
        isolate: ['harnessModels', 'harnessLlm'],
        entries: { 'scoped-models': { name: '../../plugins/scoped-models', disabled: false } },
      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'Delegate inherited', undefined, {
      model: scopedChoice,
    }),
    'Scoped parent-model',
  );
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'Delegate explicit', undefined, {
      model: scopedChoice,
    }),
    'Scoped parent-model',
  );
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, parent.id, 'Continue without an explicit model'),
    'Scoped parent-model',
  );
  const children = app.runtime.plugins.ctx.harnessSessions
    .list()
    .filter(({ parentId }) => parentId === parent.id);
  await Promise.all(children.map(({ id }) => app.runtime.plugins.ctx.harnessRuns.current(id)?.result));
  assert.equal(children.length, 2);
  const inherited = children.find(({ title }) => title === 'Inherited child task');
  const explicit = children.find(({ title }) => title === 'Explicit child task');
  assert.ok(inherited);
  assert.ok(explicit);
  assert.deepEqual(
    app.runtime.plugins.ctx.harnessSessions.log(inherited.id).projection().model,
    scopedChoice,
  );
  assert.deepEqual(app.runtime.plugins.ctx.harnessSessions.log(explicit.id).projection().model, {
    provider: 'scoped-only',
    id: 'child-model',
  });
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(inherited.id)?.state, 'completed');
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(explicit.id)?.state, 'completed');
  assert.ok(
    app.runtime.plugins.ctx.harnessSessions
      .log(parent.id)
      .projection()
      .timeline.filter(isViewMessage)
      .filter(({ role }) => role === 'toolResult')
      .every(({ isError }) => !isError),
  );
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(
    await sendRun(app.runtime.plugins.ctx.harnessRuns, sibling.id, 'Use the application model'),
    'Mock response',
  );
  assert.deepEqual(
    app.runtime.plugins.ctx.harnessSessions.log(sibling.id).projection().model,
    applicationChoice,
  );
  assert.equal(mock.requests.length, 1);
});

test('a replacement Agent receives a scoped run Fiber and releases its resources on success and failure', async (t) => {
  const { app, paths, request } = await fixture(t);
  const file = join(paths.plugins, 'agent-lifetime.log');
  writePlugin(
    paths.plugins,
    'custom-agent',
    {},
    `
import { appendFileSync } from 'node:fs';
export const provide = ['harnessAgent', 'agentMarker'];
export function apply(ctx) {
  ctx.provide('agentMarker', 'session service');
  ctx.provide('harnessAgent', {
    async run(run, input) {
      if (run.fiber === ctx.fiber || run.get('agentMarker') !== 'session service')
        throw new Error('Missing isolated run context');
      const turn = await input.prepare(1);
      const content = turn.request.messages.at(-1).content;
      const text = typeof content === 'string' ? content : content[0].text;
      run.effect(() => () => appendFileSync(${JSON.stringify(file)}, text + '\\n'));
      if (text === 'fail') throw new Error('Expected custom agent failure');
      return { role: 'assistant', content: [{ type: 'text', text: 'Custom answer' }], timestamp: Date.now() };
    },
  });
}
`,
  );
  const root = app.runtime.plugins.ctx;
  const session = root.harnessSessions.create();
  const sibling = root.harnessSessions.create();
  const configured = await request('/settings', 'PATCH', {
    scopes: {
      ['session:' + session.id]: {
        isolate: ['harnessAgent', 'agentMarker'],
        entries: { 'custom-agent': { name: '../../plugins/custom-agent', disabled: false } },
      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(await sendRun(root.harnessRuns, session.id, 'success'), 'Custom answer');
  assert.equal(readFileSync(file, 'utf8'), 'success\n');
  await assert.rejects(sendRun(root.harnessRuns, session.id, 'fail'), /Expected custom agent failure/);
  assert.equal(readFileSync(file, 'utf8'), 'success\nfail\n');
  assert.notEqual(await sendRun(root.harnessRuns, sibling.id, 'Default loop'), 'Custom answer');
});

test('Agent setup owns temporary tools and prompt sections and isolates sibling runs', async (t) => {
  const { app, paths, mock, request } = await fixture(t);
  writePlugin(
    paths.plugins,
    'run-capabilities',
    {},
    `
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
`,
  );
  const configured = await request('/settings', 'PATCH', {
    entries: { 'run-capabilities': { name: '../../plugins/run-capabilities', disabled: false } },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const root = app.runtime.plugins.ctx;
  const first = root.harnessSessions.create();
  const second = root.harnessSessions.create();
  await sendRun(root.harnessRuns, first.id, 'First run');
  assert.ok(
    !root.harnessTools
      .list({ resourceId: first.id, scope: root.harnessSessions.runScope(first.id) })
      .some(({ name }) => name === 'run_marker'),
  );
  await sendRun(root.harnessRuns, second.id, 'Second run');
  assert.match(JSON.stringify(mock.requests[0]), new RegExp('Run marker ' + first.id));
  assert.match(JSON.stringify(mock.requests[1]), new RegExp('Run marker ' + second.id));
  assert.doesNotMatch(JSON.stringify(mock.requests[1]), new RegExp('Run marker ' + first.id));
});

test('existing sessions inherit workspace contributions after the workspace plugin is reactivated', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(
    paths.plugins,
    'workspace-reload',
    {},
    `
export const inject = ['harnessPrompt', 'harnessTools'];
export function apply(ctx) {
  ctx.effect(() => ctx.harnessPrompt.register({ id: 'workspace-reload', order: 500, render: () => '[Workspace contribution]' }));
  ctx.effect(() => ctx.harnessTools.register({
    name: 'workspace_contribution', description: 'Workspace contribution', parameters: { type: 'object' },
    async execute() { return { content: [{ type: 'text', text: 'Workspace contribution' }] }; }
  }));
}
`,
  );
  const ctx = app.runtime.plugins.ctx;
  const parent = ctx.harnessSessions.create();
  const child = ctx.harnessSessions.create({ parentId: parent.id });
  const scope = 'workspace:' + parent.workspaceId;
  const workspaceKey = ctx.harnessWorkspaces.scope(parent.workspaceId!);
  const childKey = ctx.harnessSessions.runScope(child.id);
  const configured = await request('/settings', 'PATCH', {
    scopes: {
      [scope]: {
        entries: { 'workspace-reload': { name: '../../plugins/workspace-reload', disabled: false } },
      },
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const tools = () =>
    ctx.harnessTools.list({ resourceId: child.id, scope: ctx.harnessSessions.runScope(child.id) });
  assert.ok(tools().some(({ name }) => name === 'workspace_contribution'));
  const toggle = (disabled: boolean) =>
    request('/settings', 'PATCH', { entries: { 'core:workspace': { disabled } } });
  const disabled = await toggle(true);
  assert.equal(disabled.status, 200, JSON.stringify(disabled.body));
  assert.equal(ctx.get('harnessWorkspaces'), undefined);
  assert.ok(!tools().some(({ name }) => name === 'workspace_contribution'));
  const enabled = await toggle(false);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(ctx.harnessWorkspaces.scope(parent.workspaceId!), workspaceKey);
  assert.equal(ctx.harnessSessions.runScope(child.id), childKey);
  assert.ok(tools().some(({ name }) => name === 'workspace_contribution'));
  await sendRun(ctx.harnessRuns, child.id, 'Continue after reactivation');
  assert.match(JSON.stringify(mock.requests.at(-1)?.messages), /Workspace contribution/);
});
