import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, waitUntil } from '../support/api-fixture.js';

const examples = fileURLToPath(new URL('../../../docs/examples/', import.meta.url));
function copyExample(directory: string, id: string) { cpSync(join(examples, id), join(directory, id), { recursive: true }); }
function plugin(directory: string, id: string, descriptor: Record<string, unknown>, code: string) {
  const folder = join(directory, id);
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ protocol: 2, ...descriptor }));
  writeFileSync(join(folder, 'plugin.js'), code);
}

test('external services and their declared consumers share Cordis provider selection', async (t) => {
  const { paths, request } = await fixture(t);
  copyExample(paths.plugins, 'greeting-route');
  copyExample(paths.plugins, 'greeting-service');
  const patch = (data: unknown) => request('/settings', 'PATCH', data);
  const endpoint = '/extensions/greeting-route/hello?name=Pi';
  assert.match((await patch({ plugins: { 'greeting-route': true } })).body.error, /No enabled provider/);
  assert.equal((await patch({ plugins: { 'greeting-route': true, 'greeting-service': true } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Pi');
  plugin(paths.plugins, 'suffix', { provides: ['exampleSuffix'] },
    "export default (_ctx, api) => api.provide('exampleSuffix', '!');");
  assert.equal((await patch({ plugins: { suffix: true } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Pi!');

  plugin(paths.plugins, 'greeting-alt', { provides: ['exampleGreeting'] },
    "export default (_ctx, api) => api.provide('exampleGreeting', { greet: (name) => 'Welcome, ' + name });");
  assert.match((await patch({ plugins: { 'greeting-alt': true } })).body.error, /Multiple enabled providers/);
  assert.equal((await patch({ plugins: { 'greeting-alt': true }, providers: { exampleGreeting: 'greeting-alt' } })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Welcome, Pi!');
  const graph = (await request('/plugins/diagnostics')).body;
  assert.equal(graph.find(({ id }) => id === 'greeting-route').services.exampleGreeting, 'greeting-alt');
  assert.equal((await patch({ plugins: { 'greeting-alt': false }, providers: {} })).status, 200);
  assert.equal((await request(endpoint)).body.greeting, 'Hello, Pi!');
});

test('Shell delegates to a selected external process provider and still requires approval', async (t) => {
  const { paths, app, request } = await fixture(t);
  copyExample(paths.plugins, 'process-preview');
  const result = await request('/settings', 'PATCH', {
    plugins: { shell: true, 'process-preview': true }, providers: { harnessProcess: 'process-preview' }
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const { id } = app.runtime.registry.create();
  const tool = app.runtime.plugins.ctx.harnessTools.forSession(id).find(({ name }) => name === 'sandbox_shell');
  const execution = tool.execute('preview', { command: 'Preview command' }, undefined, undefined, undefined);
  const pending = await waitUntil(() => request('/approvals'), ({ body }) => body.length === 1);
  await request('/approvals', 'POST', { id: pending.body[0].id, allow: true });
  const response = await execution;
  assert.match(JSON.stringify(response.content), /Preview command/);
});

test('scoped plugins inherit declared services and tool policies, and release their own resources', async (t) => {
  const { app, paths, root, request, mock } = await fixture(t, ({ messages }) =>
    messages.at(-1).role === 'tool' ? 'Finished greeting' : { tool: 'scoped_greeting', args: {} });
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
  for (const id of [parent.id, child.id, sibling.id, outside.id]) await app.runtime.pi.open(id);
  const tools = app.runtime.plugins.ctx.harnessTools;
  const names = (id: string) => tools.forSession(id).map(({ name }) => name);
  assert.ok(names(parent.id).includes('scoped_greeting'));
  assert.ok(names(child.id).includes('scoped_greeting'));
  assert.ok(!names(child.id).includes('read'));
  for (const id of [sibling.id, outside.id]) {
    assert.ok(!names(id).includes('scoped_greeting'));
    assert.ok(names(id).includes('read'));
  }
  const tool = tools.forSession(child.id).find(({ name }) => name === 'scoped_greeting');
  assert.match(JSON.stringify(await tool.execute('scope', {}, undefined, undefined, undefined)), new RegExp(parent.id));
  assert.equal(await app.runtime.runs.send(parent.id, 'Run scoped greeting'), 'Finished greeting');
  const saved = (await request('/sessions/' + parent.id)).body;
  assert.equal(saved.messages.find((message) => message.role === 'toolResult').content[0].text, 'Greeting returned.');
  assert.ok(JSON.stringify(mock.requests).includes(parent.workspaceId + ':' + parent.id));

  const rejected = await request('/settings', 'PATCH', { scopes: { ...scopes, [workspaceKey]: {
    ...scopes[workspaceKey], pluginConfig: { 'workspace-greeting': { fail: true } }
  } } });
  assert.match(rejected.body.error, /Scoped setup failed/);
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
      api.decideTool(async ({ tool, signal }) => {
        signal.throwIfAborted();
        return tool === 'ls' ? 'deny' : undefined;
      });
    }`);
  const selected = app.runtime.registry.create();
  const other = app.runtime.registry.create();
  const child = app.runtime.registry.create({ parentId: selected.id });
  const toggle = (scopes: unknown) => request('/settings', 'PATCH', { scopes });
  assert.equal((await toggle({ ['session:' + selected.id]: { plugins: { policy: true } } })).status, 200);
  await app.runtime.pi.open(child.id);
  const tools = app.runtime.plugins.ctx.harnessTools;
  const call = (id: string) => tools.forSession(id).find(({ name }) => name === 'ls')
    .execute('policy', { path: '.' }, undefined, undefined, undefined);
  await assert.rejects(call(child.id), /Tool denied by plugin policy/);
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
  const tool = app.runtime.plugins.ctx.harnessTools.forSession(session.id).find(({ name }) => name === 'read');
  assert.match(JSON.stringify((await tool.execute('virtual', { path: 'virtual.txt' }, undefined, undefined, undefined)).content), /Provided file content/);
});
