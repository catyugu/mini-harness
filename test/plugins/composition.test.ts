import { expectPresent } from '../support/required.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, waitUntil } from '../support/api-fixture.js';

const examples = fileURLToPath(new URL('../../../docs/examples/', import.meta.url));
function copyExample(directory: string, id: string) {
  cpSync(join(examples, id), join(directory, id), { recursive: true });
  const entry = join(directory, id, 'plugin.js');
  const source = readFileSync(entry, 'utf8');
  const sdk = new URL('../../packages/contracts/plugin-sdk.js', import.meta.url).href;
  writeFileSync(entry, source.replace("'mini-harness/plugin'", JSON.stringify(sdk)));
}
function plugin(directory: string, id: string, descriptor: Record<string, unknown>, code: string) {
  const folder = join(directory, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify(descriptor));
  writeFileSync(join(folder, 'plugin.js'), `import { toolExtensions } from "${new URL('../../packages/contracts/plugin-sdk.js', import.meta.url).href}";
${code}`);
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
  plugin(paths.plugins, 'suffix', { provides: ['exampleSuffix'] },
    "export default (_ctx, api) => api.provide('exampleSuffix', '!');");
  assert.equal((await patch({ plugins: { suffix: true } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Harness!');

  plugin(paths.plugins, 'greeting-alt', { provides: ['exampleGreeting'] },
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
  const { id } = app.runtime.registry.create();
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
  plugin(paths.plugins, 'workspace-greeting', { scope: 'workspace', provides: ['exampleGreeting'] }, `
    import { appendFileSync } from 'node:fs';
    export default (_ctx, api) => {
      if (api.config.fail) throw new Error('Scoped setup failed');
      api.onDispose(() => appendFileSync(${JSON.stringify(cleaned)}, 'released\\n'));
      api.provide('exampleGreeting', { greet: (name) => api.scope.workspaceId + ':' + name });
    };`);
  const secondWorkspace = join(root, 'other');
  mkdirSync(secondWorkspace);
  const workspace = (await request('/workspaces', 'POST', { path: secondWorkspace })).body;
  const parent = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: parent.id });
  const sibling = app.runtime.registry.create();
  const outside = app.runtime.registry.create({ workspaceId: workspace.id });
  const workspaceKey = 'workspace:' + parent.workspaceId;
  const sessionKey = 'session:' + parent.id;
  const scopes = {
    [workspaceKey]: { plugins: { 'workspace-greeting': true } },
    [sessionKey]: { plugins: { 'scoped-tool': true }, disabledTools: ['read'] }
  };
  const enabled = await request('/settings', 'PATCH', { scopes });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.body));
  assert.equal(existsSync(cleaned), false);
  for (const id of [parent.id, child.id, sibling.id, outside.id]) await app.runtime.agent.prepare(id);
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
  assert.equal(await app.runtime.runs.send(parent.id, 'Run scoped greeting'), 'Finished greeting');
  const saved = (await request('/sessions/' + parent.id)).body;
  assert.equal(expectPresent(saved.messages.find((message: { role: string; content: { text?: string }[] }) => message.role === 'toolResult'), 'persisted tool result').content[0]?.text, 'Greeting returned.');
  assert.ok(JSON.stringify(mock.requests).includes(parent.workspaceId + ':' + parent.id));

  const rejected = await request('/settings', 'PATCH', { scopes: { ...scopes, [workspaceKey]: {
    ...scopes[workspaceKey], pluginConfig: { 'workspace-greeting': { fail: true } }
  } } });
  assert.match(rejected.body.error, /Internal server error/);
  assert.ok(names(child.id).includes('scoped_greeting'));
  assert.equal((await request('/workspaces/' + parent.workspaceId, 'DELETE')).status, 200);
  assert.equal(readFileSync(cleaned, 'utf8'), 'released\nreleased\n');
  assert.deepEqual((await request('/settings')).body.scopes, {});
  assert.ok(names(outside.id).includes('read'));
});

test('unloading a route signals an active request and waits for its cleanup', async (t) => {
  const { paths, root, request } = await fixture(t);
  const entered = join(root, 'entered');
  const drained = join(root, 'drained');
  plugin(paths.plugins, 'drain', { inject: ['harnessRoutes'] }, `
    import { writeFileSync } from 'node:fs';
    export default (_ctx, api) => api.registerRoute('GET', '/wait', async ({ signal }) => {
      writeFileSync(${JSON.stringify(entered)}, 'ready');
      await new Promise((done) => signal.addEventListener('abort', done, { once: true }));
      await new Promise((done) => setImmediate(done));
      writeFileSync(${JSON.stringify(drained)}, 'done');
    });`);
  const toggle = (active: boolean) => request('/settings', 'PATCH', { plugins: { drain: active } });
  assert.equal((await toggle(true)).status, 200);
  const current = request('/extensions/drain/wait');
  await waitUntil(() => existsSync(entered), Boolean);
  assert.equal((await toggle(false)).status, 200);
  assert.equal(readFileSync(drained, 'utf8'), 'done');
  assert.equal((await current).status, 400);
  assert.equal((await request('/extensions/drain/wait')).status, 404);
});

test('a decision hook can deny an inherited tool and is removed with its owner', async (t) => {
  const { app, paths, request } = await fixture(t);
  plugin(paths.plugins, 'policy', { scope: 'session' }, `
    export default function(_ctx, api) {
      api.contribute(toolExtensions.decide, async ({ tool, signal }) => {
        signal.throwIfAborted();
        return tool === 'ls' ? 'deny' : undefined;
      });
    }`);
  const selected = app.runtime.registry.create();
  const other = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: selected.id });
  const toggle = (scopes: unknown) => request('/settings', 'PATCH', { scopes });
  assert.equal((await toggle({ ['session:' + selected.id]: { plugins: { policy: true } } })).status, 200);
  await app.runtime.agent.prepare(child.id);
  const tools = app.runtime.plugins.ctx.harnessTools;
  const call = (id: string) => expectPresent(tools.forSession(id).find(({ name }) => name === 'ls'), 'ls tool')
    .execute('policy', { path: '.' }, undefined, undefined, undefined);
  await assert.rejects(call(child.id), /Tool denied by conversation or plugin policy/);
  assert.equal((await call(other.id)).content[0].type, 'text');
  assert.equal((await toggle({})).status, 200);
  assert.equal((await call(child.id)).content[0].type, 'text');
});

test('file tools and HTTP preview consume the same selected File Access provider', async (t) => {
  const { app, paths, request } = await fixture(t);
  plugin(paths.plugins, 'virtual-files', { provides: ['harnessFileAccess'] }, `
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
  const session = app.runtime.registry.create();
  const preview = await request('/workspaces/' + session.workspaceId + '/files/preview?path=virtual.txt');
  assert.equal(preview.body.content, 'Provided file content');
  const tool = expectPresent(app.runtime.plugins.ctx.harnessTools.forSession(session.id).find(({ name }) => name === 'read'), 'read tool');
  assert.match(JSON.stringify((await tool.execute('virtual', { path: 'virtual.txt' }, undefined, undefined, undefined)).content), /Provided file content/);
});

test('native runs use the nearest scoped LLM provider while siblings retain the application adapter', async (t) => {
  const { app, paths, request, mock } = await fixture(t);
  plugin(paths.plugins, 'scoped-llm', { scope: 'session', provides: ['harnessLlm'] }, `
    export default (_ctx, api) => api.provide('harnessLlm', {
      async *stream(request) {
        request.signal.throwIfAborted();
        yield { type: 'text-delta', text: api.config.answer };
        yield { type: 'done', message: { role: 'assistant', timestamp: Date.now(),
          content: [{ type: 'text', text: api.config.answer }], stopReason: 'stop' } };
      }
    });`);
  const parent = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: parent.id });
  const sibling = app.runtime.registry.create();
  const scope = (answer: string) => ({ plugins: { 'scoped-llm': true }, providers: { harnessLlm: 'scoped-llm' },
    pluginConfig: { 'scoped-llm': { answer } } });
  const scopes = { ['session:' + parent.id]: scope('Parent adapter'), ['session:' + child.id]: scope('Child adapter') };
  const configured = await request('/settings', 'PATCH', { scopes });
  assert.equal(configured.status, 200, JSON.stringify(configured.body));
  assert.equal(await app.runtime.runs.send(parent.id, 'Parent task'), 'Parent adapter');
  assert.equal(await app.runtime.runs.send(child.id, 'Child task'), 'Child adapter');
  assert.equal(await app.runtime.runs.send(sibling.id, 'Sibling task'), 'Mock response');
  assert.equal(mock.requests.length, 1);
  assert.strictEqual(app.runtime.plugins.require(child.id, 'harnessModels'), app.runtime.plugins.ctx.harnessModels);
  assert.equal((await request('/settings', 'PATCH', { scopes: {
    ['session:' + parent.id]: scopes['session:' + parent.id], ['session:' + child.id]: { disabledTools: ['sandbox_shell'] }
  } })).status, 200);
  assert.equal(await app.runtime.runs.send(child.id, 'Use inherited adapter'), 'Parent adapter');
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
  plugin(paths.plugins, 'application-sandbox', { provides: ['harnessSandbox'] },
    `export default (_ctx, api) => api.provide('harnessSandbox', ${isolated('application sandbox')});`);
  plugin(paths.plugins, 'scoped-environment', { scope: 'session', provides: ['harnessFileAccess', 'harnessSandbox'] }, `
    export default (_ctx, api) => {
      api.provide('harnessFileAccess', { open: () => ({
        access: async () => {}, imageType: async () => null,
        readFile: async () => Buffer.from('scoped file'),
        async *chunks() { yield Buffer.from('scoped file'); }
      }) });
      api.provide('harnessSandbox', ${isolated('scoped sandbox')});
    };`);
  plugin(paths.plugins, 'scoped-process', { scope: 'session', provides: ['harnessProcess'] }, `
    export default (_ctx, api) => api.provide('harnessProcess', {
      async run(request) {
        if (!request.sessionId) throw new Error('Missing execution scope');
        return { code: 0, signal: null, stdout: 'scoped process', stderr: '', truncated: false };
      }
    });`);
  const parent = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: parent.id });
  const sibling = app.runtime.registry.create();
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
  const lastTool = (id: string) => expectPresent(app.runtime.agent.messages(id).filter(({ role }) => role === 'toolResult').at(-1), 'tool result');
  await app.runtime.runs.send(child.id, 'read in inherited scope');
  assert.match(JSON.stringify(lastTool(child.id).content), /scoped file/);
  await app.runtime.runs.send(sibling.id, 'read in sibling');
  assert.match(JSON.stringify(lastTool(sibling.id).content), /application file/);
  for (const [id, expected] of [[parent.id, 'scoped sandbox'], [child.id, 'scoped process'], [sibling.id, 'application sandbox']]) {
    const running = app.runtime.runs.send(id, 'shell execution');
    const pending = await waitUntil(() => request('/approvals'), ({ body }) => body.some((item: { sessionId: string }) => item.sessionId === id));
    const approval = expectPresent(pending.body.find((item: { sessionId: string }) => item.sessionId === id), 'pending approval');
    assert.equal((await request('/approvals', 'POST', { id: approval.id, allow: true })).status, 200);
    await running;
    assert.equal(lastTool(id).isError, false);
    assert.match(JSON.stringify(lastTool(id).content), new RegExp(expected));
  }
});
