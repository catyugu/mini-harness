import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolveCapabilities } from '@mini-harness/kernel/composition';
import { PluginCatalog } from '@mini-harness/plugins/catalog';
import { DEFAULTS, mergeSettings, validateSettings } from '@mini-harness/settings/config';
import { writePlugin } from '../support/plugin-fixture.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, waitUntil } from '../support/api-fixture.js';

const examples = fileURLToPath(new URL('../../../docs/examples/', import.meta.url));
function copyExample(directory: string, id: string) {
  cpSync(join(examples, id), join(directory, id), { recursive: true });
  const entry = join(directory, id, 'plugin.js');
  const source = readFileSync(entry, 'utf8');
  const sdk = new URL('../../packages/sdk/src/plugin.js', import.meta.url).href;
  writeFileSync(entry, source.replace("'mini-harness/plugin'", JSON.stringify(sdk)));
}
test('external services and their declared consumers share Cordis provider selection', async (t) => {
  const { paths, request } = await fixture(t);
  copyExample(paths.plugins, 'greeting-route');
  copyExample(paths.plugins, 'greeting-service');
  const patch = (data: unknown) => request('/settings', 'PATCH', data);
  const endpoint = '/extensions/greeting-route/hello?name=Harness';
  assert.match((await patch({ plugins: { 'greeting-route': true } })).body.error, /No enabled provider/);
  assert.equal((await patch({ plugins: { 'greeting-route': true, 'greeting-service': true } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness');
  writePlugin(paths.plugins, 'suffix', { provides: ['exampleSuffix'] },
    "export default (_ctx, api) => api.provide('exampleSuffix', '!');");
  assert.equal((await patch({ plugins: { suffix: true } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');

  writePlugin(paths.plugins, 'greeting-alt', { provides: ['exampleGreeting'] },
    "export default (_ctx, api) => api.provide('exampleGreeting', { greet: (name) => 'Welcome, ' + name });");
  assert.match((await patch({ plugins: { 'greeting-alt': true } })).body.error, /Multiple enabled providers/);
  assert.equal((await patch({ plugins: { 'greeting-alt': true }, providers: { exampleGreeting: 'greeting-alt' } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Welcome, Harness!');
  const graph = (await request('/plugins/diagnostics')).body;
  assert.equal(expectPresent(graph.find(({ id }: { id: string }) => id === 'greeting-route'), 'greeting route').services.exampleGreeting, 'greeting-alt');
  assert.equal((await patch({ plugins: { 'greeting-alt': false }, providers: {} })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');
});

test('Shell delegates to a selected external process provider and still requires approval', async (t) => {
  const { paths, app, request } = await fixture(t);
  copyExample(paths.plugins, 'process-preview');
  const result = await request('/settings', 'PATCH', {
    plugins: { shell: true, 'process-preview': true }, providers: { harnessProcess: 'process-preview' }
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { id } = app.runtime.plugins.ctx.harnessRegistry.create();
  const tool = expectPresent(app.runtime.plugins.ctx.harnessTools.forSession(id).find(({ name }) => name === 'sandbox_shell'), 'shell tool');
  const execution = tool.execute('preview', { command: 'Preview command' }, undefined, undefined, undefined);
  const pending = await waitUntil(() => request('/approvals'), ({ body }) => body.length === 1);
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: true });
  const response = await execution;
  assert.match(JSON.stringify(response.content), /Preview command/);
});

test('scoped plugins inherit declared services and tool policies, and release their own resources', async (t) => {
  const { app, paths, root, request, mock } = await fixture(t, ({ messages }) =>
    messages.at(-1)?.role === 'tool' ? 'Finished greeting' : { tool: 'scoped_greeting', args: {} });
  copyExample(paths.plugins, 'scoped-tool');
  const cleaned = join(root, 'released');
  writePlugin(paths.plugins, 'workspace-greeting', { scope: 'workspace', provides: ['exampleGreeting'] }, `
    import { appendFileSync } from 'node:fs';
    export default (ctx, api) => {
      if (api.config.fail) throw new Error('Scoped setup failed');
      ctx.effect(() => () => appendFileSync(${JSON.stringify(cleaned)}, 'released\\n'));
      api.provide('exampleGreeting', { greet: (name) => api.scope.workspaceId + ':' + name });
      api.registerScopeRequest('greet', (input) => {
        api.storage.write('seen', input);
        api.invalidate();
        return { workspaceId: api.scope.workspaceId, input };
      });
    };`);
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
    [workspaceKey]: { plugins: { 'workspace-greeting': true } },
    [sessionKey]: { plugins: { 'scoped-tool': true }, disabledTools: ['read'] }
  };
  const enabled = await request('/settings', 'PATCH', { scopes });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(existsSync(cleaned), false);
  const operation = (key: string) => '/plugins/workspace-greeting/scopes/' + encodeURIComponent(key) + '/greet';
  assert.deepEqual((await request(operation(workspaceKey), 'POST', { input: 'World' })).body,
    { workspaceId: parent.workspaceId, input: 'World' });
  assert.equal((await request(operation('workspace:' + workspace.id), 'POST', {})).status, 404);
  const instance = join(paths.home, 'plugin-data', 'workspace-greeting', createHash('sha256').update(workspaceKey).digest('hex'));
  assert.ok(existsSync(join(instance, 'seen.json')));
  for (const id of [parent.id, child.id, sibling.id, outside.id]) await app.runtime.plugins.prepare(id);
  const tools = app.runtime.plugins.ctx.harnessTools;
  const names = (id: string) => tools.forSession(id).map(({ name }) => name);
  assert.ok(names(parent.id).includes('scoped_greeting'));
  assert.ok(names(child.id).includes('scoped_greeting'));
  assert.ok(!names(child.id).includes('read'));
  for (const id of [sibling.id, outside.id]) {
    assert.ok(!names(id).includes('scoped_greeting'));
    assert.ok(names(id).includes('read'));
  }
  const tool = expectPresent(tools.forSession(child.id).find(({ name }) => name === 'scoped_greeting'), 'scoped greeting tool');
  assert.match(JSON.stringify(await tool.execute('scope', {}, undefined, undefined, undefined)), new RegExp(parent.id));
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Run scoped greeting'), 'Finished greeting');
  const saved = (await request('/sessions/' + parent.id)).body;
  assert.equal(expectPresent(saved.messages.find((message: { role: string; content: { text?: string }[] }) => message.role === 'toolResult'), 'persisted tool result').content[0]?.text, 'Greeting returned.');
  assert.ok(JSON.stringify(mock.requests).includes(parent.workspaceId + ':' + parent.id));

  const rejected = await request('/settings', 'PATCH', { scopes: { ...scopes, [workspaceKey]: {
    ...scopes[workspaceKey], pluginConfig: { 'workspace-greeting': { fail: true } }
  } } });
  assert.equal(rejected.status, 400);
  assert.match(rejected.body.error, /workspace-greeting: Scoped setup failed/);
  assert.ok(names(child.id).includes('scoped_greeting'));
  assert.equal((await request('/workspaces/' + parent.workspaceId, 'DELETE')).status, 200);
  assert.equal(readFileSync(cleaned, 'utf8'), 'released\nreleased\n');
  assert.deepEqual((await request('/settings')).body.scopes, {});
  assert.equal(existsSync(instance), false);
  assert.equal((await request(operation(workspaceKey), 'POST', {})).status, 404);
  assert.ok(names(outside.id).includes('read'));
});

test('read-only permissions are bound to the selected tool registration', async (t) => {
  const { app, mock, paths, request } = await fixture(t);
  writePlugin(paths.plugins, 'replacement', { scope: 'session', inject: ['harnessTools'] }, `
    export default (_ctx, api) => {
      for (const name of ['read', 'custom']) api.contribute(toolExtensions.register, {
        name, description: 'replacement', parameters: { type: 'object' },
        async execute() { return { content: [{ type: 'text', text: 'Authorized local read' }] }; }
      }, { access: 'readOnly' });
    };`);
  const { plugins } = app.runtime;
  const registry = plugins.ctx.harnessRegistry;
  const parent = registry.create({ permission: 'readOnly' });
  const child = registry.create({ parentId: parent.id, permission: 'fullAccess' });
  const list = (id: string) => plugins.ctx.harnessTools.forSession(id);
  const original = expectPresent(list(child.id).find(({ name }) => name === 'read'), 'inherited read tool');
  assert.ok(list(child.id).some(({ name }) => name === 'load_skill'));
  assert.equal((await request('/settings', 'PATCH', {
    scopes: { ['session:' + child.id]: { plugins: { replacement: true } } }
  })).status, 200);
  await plugins.prepare(child.id);
  assert.equal(list(child.id).some(({ name }) => name === 'read' || name === 'custom'), false);
  assert.ok(list(parent.id).some(({ name }) => name === 'read'));
  await assert.rejects(original.execute('old', { path: 'README.md' }), /Tool denied/);
  await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Continue');
  const sent = expectPresent(mock.requests.at(-1), 'request with tools');
  assert.equal(JSON.stringify(sent.tools).includes('"name":"read"'), false);
  assert.equal(JSON.stringify(sent.tools).includes('"name":"load_skill"'), true);
  assert.equal((await request('/settings', 'PATCH', { readOnlyTools: { replacement: ['custom'] } })).status, 200);
  const granted = expectPresent(list(child.id).find(({ name }) => name === 'custom'), 'granted registration');
  assert.match(JSON.stringify(await granted.execute('granted', {})), /Authorized local read/);
  assert.ok(!list(child.id).some(({ name }) => name === 'read'));
  assert.equal((await request('/settings', 'PATCH', { readOnlyTools: {} })).status, 200);
  await assert.rejects(granted.execute('revoked', {}), /Tool denied/);
});

test('the host tool authorization service cannot be replaced at either scope', async (t) => {
  const { app, paths, request } = await fixture(t);
  for (const scope of ['application', 'session']) {
    writePlugin(paths.plugins, 'tools-' + scope, { scope, provides: ['harnessTools'] }, `
      export default () => { throw new Error('Protected provider must never mount'); };
    `);
  }
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  const application = await request('/settings', 'PATCH', {
    plugins: { 'tools-application': true }, providers: { harnessTools: 'tools-application' }
  });
  assert.equal(application.status, 400);
  assert.match(application.body.error, /Protected service cannot be overridden: harnessTools/);
  const scoped = await request('/settings', 'PATCH', { scopes: { ['session:' + session.id]: {
    plugins: { 'tools-session': true }, providers: { harnessTools: 'tools-session' }
  } } });
  assert.equal(scoped.status, 400);
  assert.match(scoped.body.error, /Protected service cannot be overridden: harnessTools/);
  assert.ok(app.runtime.plugins.ctx.harnessTools.forSession(session.id).some(({ name }) => name === 'read'));
});

test('file tools and HTTP preview consume the same selected File Access provider', async (t) => {
  const { app, paths, request } = await fixture(t);
  writePlugin(paths.plugins, 'virtual-files', { provides: ['harnessFileAccess'] }, `
    export default function(_ctx, api) {
      const data = Buffer.from('Provided file content');
      api.provide('harnessFileAccess', { open: () => ({
        access: async () => {},
        readFile: async () => data,
        imageType: async () => null,
        async *chunks() { yield data; }
      }) });
    }`);
  const selection = { plugins: { 'virtual-files': true }, providers: { harnessFileAccess: 'virtual-files' } };
  assert.equal((await request('/settings', 'PATCH', selection)).status, 200);
  const session = app.runtime.plugins.ctx.harnessRegistry.create();
  const preview = await request('/workspaces/' + session.workspaceId + '/files/preview?path=virtual.txt');
  assert.equal(preview.body.content, 'Provided file content');
  const tool = expectPresent(app.runtime.plugins.ctx.harnessTools.forSession(session.id).find(({ name }) => name === 'read'), 'read tool');
  assert.match(JSON.stringify((await tool.execute('virtual', { path: 'virtual.txt' }, undefined, undefined, undefined)).content), /Provided file content/);
});

test('native runs use the nearest scoped LLM provider while siblings retain the application adapter', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(paths.plugins, 'scoped-llm', { scope: 'session', provides: ['harnessLlm'] }, `
    export default (_ctx, api) => api.provide('harnessLlm', {
      async *stream(request) {
        request.signal.throwIfAborted();
        yield { type: 'text-delta', text: api.config.answer };
        yield { type: 'done', message: { role: 'assistant', timestamp: Date.now(),
          content: [{ type: 'text', text: api.config.answer }], stopReason: 'stop' } };
      }
    });`);
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const scope = (answer: string) => ({ plugins: { 'scoped-llm': true }, providers: { harnessLlm: 'scoped-llm' },
    pluginConfig: { 'scoped-llm': { answer } } });
  const scopes = { ['session:' + parent.id]: scope('Parent adapter'), ['session:' + child.id]: scope('Child adapter') };
  const configured = await request('/settings', 'PATCH', { scopes });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Parent task'), 'Parent adapter');
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Child task'), 'Child adapter');
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(sibling.id, 'Sibling task'), 'Mock response');
  assert.equal(mock.requests.length, 1);
  assert.strictEqual(app.runtime.plugins.require(child.id, 'harnessModels'), app.runtime.plugins.ctx.harnessModels);
  assert.equal((await request('/settings', 'PATCH', { scopes: {
    ['session:' + parent.id]: scopes['session:' + parent.id], ['session:' + child.id]: { disabledTools: ['sandbox_shell'] }
  } })).status, 200);
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'Use inherited adapter'), 'Parent adapter');
  assert.equal(mock.requests.length, 1);
});

test('native file and shell tools use scoped file, process and sandbox services without changing siblings', async (t) => {
  const { app, paths, request } = await fixture(t, ({ messages }) => {
    const last = expectPresent(messages.at(-1), 'model input');
    return last.role === 'tool' ? 'Completed' : last.content.startsWith('read')
      ? { tool: 'read', args: { path: 'note.txt' } }
      : { tool: 'sandbox_shell', args: { command: 'requested command' } };
  });
  writeFileSync(join(paths.cwd, 'note.txt'), 'application file');
  const isolated = (output: string) => `({ async prepare(request) {
    return { file: process.execPath, args: ['-e', ${JSON.stringify('process.stdout.write(' + JSON.stringify(output) + ')')}],
      cwd: request.cwd, env: {} };
  } })`;
  writePlugin(paths.plugins, 'application-sandbox', { provides: ['harnessSandbox'] },
    `export default (_ctx, api) => api.provide('harnessSandbox', ${isolated('application sandbox')});`);
  writePlugin(paths.plugins, 'scoped-environment', { scope: 'session', provides: ['harnessFileAccess', 'harnessSandbox'] }, `
    export default (_ctx, api) => {
      api.provide('harnessFileAccess', { open: () => ({
        access: async () => {}, imageType: async () => null,
        readFile: async () => Buffer.from('scoped file'),
        async *chunks() { yield Buffer.from('scoped file'); }
      }) });
      api.provide('harnessSandbox', ${isolated('scoped sandbox')});
    };`);
  writePlugin(paths.plugins, 'scoped-process', { scope: 'session', provides: ['harnessProcess'] }, `
    export default (_ctx, api) => api.provide('harnessProcess', {
      async run(request) {
        if (!request.sessionId) throw new Error('Missing execution scope');
        return { code: 0, signal: null, stdout: 'scoped process', stderr: '', truncated: false };
      }
    });`);
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const child = app.runtime.plugins.ctx.harnessRegistry.create({ parentId: parent.id });
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const configured = await request('/settings', 'PATCH', {
    plugins: { shell: true, 'application-sandbox': true },
    pluginConfig: { shell: { mode: 'isolated' } }, providers: { harnessSandbox: 'application-sandbox' },
    scopes: {
      ['session:' + parent.id]: { plugins: { 'scoped-environment': true },
        providers: { harnessFileAccess: 'scoped-environment', harnessSandbox: 'scoped-environment' } },
      ['session:' + child.id]: { plugins: { 'scoped-process': true }, providers: { harnessProcess: 'scoped-process' } }
    }
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  const preview = (id: string) => request('/workspaces/' + parent.workspaceId + '/files/preview?path=note.txt&sessionId=' + id);
  assert.equal((await preview(parent.id)).body.content, 'scoped file', 'HTTP inspection prepares the lazy scope');
  assert.equal((await preview(sibling.id)).body.content, 'application file');
  const lastTool = (id: string) => expectPresent(app.runtime.plugins.ctx.harnessRegistry.log(id).projection().messages.filter(({ role }) => role === 'toolResult').at(-1), 'tool result');
  await app.runtime.plugins.ctx.harnessRuns.send(child.id, 'read in inherited scope');
  assert.match(JSON.stringify(lastTool(child.id).content), /scoped file/);
  await app.runtime.plugins.ctx.harnessRuns.send(sibling.id, 'read in sibling');
  assert.match(JSON.stringify(lastTool(sibling.id).content), /application file/);
  for (const [id, expected] of [[parent.id, 'scoped sandbox'], [child.id, 'scoped process'], [sibling.id, 'application sandbox']]) {
    const running = app.runtime.plugins.ctx.harnessRuns.send(id, 'shell execution');
    const pending = await waitUntil(() => request('/approvals'), ({ body }) => body.some((item: { sessionId: string }) => item.sessionId === id));
    const approval = expectPresent(pending.body.find((item: { sessionId: string }) => item.sessionId === id), 'pending approval');
    assert.equal((await request('/approvals', 'POST', { id: approval.id, allow: true })).status, 200);
    await running;
    assert.equal(lastTool(id).isError, false);
    assert.match(JSON.stringify(lastTool(id).content), new RegExp(expected));
  }
});

test('explicit scoped provider choice shadows inherited service only in the child graph', () => {
  const parent = new Map([['greeting', 'global'], ['harnessRoutes', 'application']]);
  const plugins = [
    { id: 'consumer', inject: ['greeting'] },
    { id: 'local', provides: ['greeting'] }
  ];
  assert.throws(() => resolveCapabilities(plugins, parent), /Multiple enabled providers/);
  const child = resolveCapabilities(plugins, parent, { greeting: 'local' });
  assert.equal(child.providers.get('greeting'), 'local');
  assert.equal(child.ordered[0].descriptor.id, 'local');
  assert.equal(child.ordered.find((item) => item.descriptor.id === 'consumer')?.services.greeting, 'local');
  assert.equal(parent.get('greeting'), 'global');
  assert.equal(resolveCapabilities([{ id: 'consumer', inject: ['greeting'] }], parent)
    .ordered[0].services.greeting, 'global');
  assert.throws(() => resolveCapabilities(
    [{ id: 'fake', provides: ['harnessRoutes'] }], parent, { harnessRoutes: 'fake' },
    undefined, new Set(['harnessRoutes'])), /Protected service/);
  assert.throws(() => resolveCapabilities(
    [{ id: 'consumer', inject: ['greeting'] }], parent, { greeting: 'missing' }
  ), /Selected provider/);
  const inherited = new Map([['greeting', 'local']]);
  const descriptor = [{ id: 'local', provides: ['greeting'] }];
  assert.throws(() => resolveCapabilities(descriptor, inherited), /Multiple enabled providers/);
  assert.equal(resolveCapabilities(descriptor, inherited, { greeting: 'local' }).providers.get('greeting'), 'local');
  assert.throws(() => resolveCapabilities(descriptor, inherited, { greeting: 'local' }, undefined,
    new Set(['greeting'])), /Protected service/);
});

test('catalog computes independent scoped provider maps and rejects fixed service shadows', () => {
  const folder = mkdtempSync(join(tmpdir(), 'mini-scope-providers-'));
  try {
    const catalog = new PluginCatalog(folder, [
      { id: 'global', title: 'Global', description: '', scope: 'application',
        required: true, provides: ['greeting'] },
      { id: 'local', title: 'Local', description: '', scope: 'workspace', provides: ['greeting'] }
    ], ['harnessRoutes']);
    const key = 'workspace:' + 'a'.repeat(32);
    const settings = mergeSettings(DEFAULTS as any, {
      scopes: { [key]: { plugins: { local: true }, providers: { greeting: 'local' } } }
    });
    validateSettings(settings);
    const descriptors = catalog.descriptors();
    descriptors.push({ id: 'fake-locked', title: 'Fake', description: '', scope: 'workspace', provides: ['harnessRoutes'] });
    const app = catalog.plans(settings, descriptors, 'application',
      new Map([['harnessRoutes', 'application']]), new Set());
    assert.equal(app.providers.get('greeting'), 'global');
    const inheritedIds = new Set(app.plans.map(({ id }) => id));
    const workspace = catalog.plans(settings, descriptors, 'workspace', app.providers,
      inheritedIds, settings.scopes[key]);
    assert.equal(workspace.providers.get('greeting'), 'local');
    assert.equal(app.providers.get('greeting'), 'global');
    assert.equal(catalog.plans(settings, descriptors, 'workspace', app.providers,
      inheritedIds).providers.get('greeting'), 'global');
    assert.throws(() => catalog.plans(settings, descriptors, 'workspace', app.providers,
      inheritedIds, { plugins: { 'fake-locked': true }, providers: { harnessRoutes: 'fake-locked' } }),
    /Protected service/);
    assert.throws(() => validateSettings({ ...settings, scopes: {
      [key]: { providers: { greeting: '../outside' } }
    } }), /Invalid provider selection/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('scoped model catalogs govern explicit runs and inherited or model-selected delegation without changing siblings', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  writePlugin(paths.plugins, 'scoped-models', { scope: 'session', provides: ['harnessModels', 'harnessLlm'] }, `
    export default (_ctx, api) => {
      const provider = 'scoped-only';
      const ids = ['parent-model', 'child-model'];
      const resolve = (choice) => {
        const id = choice?.id || ids[0];
        if (choice?.provider !== provider || !ids.includes(id)) return undefined;
        return { provider, id };
      };
      const list = () => ids.map(id => ({ provider, id, name: id, configured: true, thinkingLevels: ['off'] }));
      api.provide('harnessModels', {
        list, available: async () => list(), resolve,
        capabilities(choice) {
          const model = resolve(choice);
          return { id: model.id, name: model.id, input: ['text'], contextWindow: 32000, maxTokens: 1024, reasoning: false };
        }
      });
      api.provide('harnessLlm', {
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
  `);
  const parent = app.runtime.plugins.ctx.harnessRegistry.create();
  const sibling = app.runtime.plugins.ctx.harnessRegistry.create();
  const scopedChoice = { provider: 'scoped-only', id: 'parent-model' };
  const applicationChoice = { ...app.runtime.plugins.ctx.harnessModelPreference.recent() };
  assert.equal(app.runtime.plugins.ctx.harnessModels.resolve(scopedChoice), undefined);
  const configured = await request('/settings', 'PATCH', { scopes: {
    ['session:' + parent.id]: { plugins: { 'scoped-models': true },
      providers: { harnessModels: 'scoped-models', harnessLlm: 'scoped-models' } }
  } });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));

  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Delegate inherited', undefined, { model: scopedChoice }), 'Scoped parent-model');
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Delegate explicit', undefined, { model: scopedChoice }), 'Scoped parent-model');
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(parent.id, 'Continue without an explicit model'), 'Scoped parent-model');
  const children = app.runtime.plugins.ctx.harnessRegistry.list().filter(({ parentId }) => parentId === parent.id);
  assert.equal(children.length, 2);
  const inherited = children.find(({ title }) => title === 'Inherited child task');
  const explicit = children.find(({ title }) => title === 'Explicit child task');
  assert.ok(inherited); assert.ok(explicit);
  assert.deepEqual(app.runtime.plugins.ctx.harnessRegistry.log(inherited.id).projection().model, scopedChoice);
  assert.deepEqual(app.runtime.plugins.ctx.harnessRegistry.log(explicit.id).projection().model, { provider: 'scoped-only', id: 'child-model' });
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(inherited.id)?.state, 'completed');
  assert.equal(app.runtime.plugins.ctx.harnessRuns.info(explicit.id)?.state, 'completed');
  assert.ok(app.runtime.plugins.ctx.harnessRegistry.log(parent.id).projection().messages.filter(({ role }) => role === 'toolResult').every(({ isError }) => !isError));
  assert.deepEqual(app.runtime.plugins.ctx.harnessModelPreference.recent(), applicationChoice);
  assert.equal(await app.runtime.plugins.ctx.harnessRuns.send(sibling.id, 'Use the application model'), 'Mock response');
  assert.deepEqual(app.runtime.plugins.ctx.harnessRegistry.log(sibling.id).projection().model, applicationChoice);
  assert.equal(mock.requests.length, 1);
});
