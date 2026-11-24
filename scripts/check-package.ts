import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { readServerInfo } from '@mini-harness/host/process';
import { parseNpmPackResult } from './npm-pack.js';
import { waitUntil } from '../test/support/api-fixture.js';
import { createFixturePaths, createMockProvider } from '../test/helpers/mock-provider.js';

const execFile = promisify(exec);
const npmPath = process.env.MINI_HARNESS_NPM_CLI ?? resolve(dirname(process.execPath),
  process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
await access(npmPath);
const npm = (args: string[], options = {}) => execFile(process.execPath, [npmPath, ...args], { timeout: 120000, ...options });

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  await new Promise<void>((done) => listener.close(() => done()));
  if (!address || typeof address === 'string') throw new Error('Missing local port');
  return address.port;
}

async function checkPackage() {
  const work = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'mini-harness-pack-'));
  const mock = await createMockProvider(({ messages }) =>
    messages.at(-1)?.content === 'Pack smoke test'
      ? { tool: 'save_task_note', args: { note: 'Installed SDK recorded progress' } }
      : 'Mock response');
  const { root, paths } = createFixturePaths(mock.url);
  const installed = join(work, 'install');
  const plugin = join(installed, 'task-notes');
  const env = { ...process.env, MINI_HARNESS_HOME: paths.home, MINI_HARNESS_DEV_PLUGIN: plugin };
  let started = false;
  const cli = (...args: string[]) => npm(['exec', '--offline', '--', 'mini-harness', ...args], { cwd: installed, env });
  try {
    const packed = await npm(['pack', '--json', '--pack-destination', work], { cwd: resolve('.') });
    const { name, filename, files } = parseNpmPackResult(packed.stdout);
    assert.ok(files.every(({ path }: { path: string }) =>
      !/^dist\/(?:scripts|test)\//.test(path) &&
      !/^dist\/packages\/[^/]+\/package\.json$/.test(path) &&
      !/^dist\/.*\/tests\//.test(path) &&
      !/\.(?:test|spec)\.js$/.test(path)), 'Published package must exclude test artifacts');
    await mkdir(installed);
    const tarball = 'file:../' + filename;
    const { version: nodeTypes } = JSON.parse(await readFile(resolve('node_modules/@types/node/package.json'), 'utf8'));
    // Use the Bedrock middleware version already selected by the workspace lockfile.
    const pi = createRequire(import.meta.resolve('@earendil-works/pi-ai'));
    const bedrock = createRequire(pi.resolve('@aws-sdk/client-bedrock-runtime'));
    const { version: websocketMiddleware } = bedrock('@aws-sdk/middleware-websocket/package.json');
    const fixture = {
      name: 'mini-harness-install-check', private: true, type: 'module', version: '0.0.0',
      dependencies: { [name]: tarball }, devDependencies: { '@types/node': nodeTypes },
      overrides: { '@aws-sdk/middleware-websocket': websocketMiddleware }
    };
    await writeFile(join(installed, 'package.json'), JSON.stringify(fixture));
    console.log('Installing ' + filename + ' in a standalone npm project');
    await npm(['install', '--prefer-offline', '--include=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: installed, timeout: 240000
    });
    const published = join(installed, 'node_modules', name);
    const manifest = JSON.parse(await readFile(join(published, 'package.json'), 'utf8'));
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies'])
      assert.doesNotMatch(JSON.stringify(manifest[section] ?? {}), /@mini-harness\/|workspace:\*/);
    assert.deepEqual(Object.keys(manifest.exports).sort(), ['./browser-plugin', './cordis', './plugin']);
    for (const { path } of files.filter(({ path }) => /\.(?:js|d\.ts)$/.test(path))) {
      const emitted = await readFile(join(published, path), 'utf8');
      assert.doesNotMatch(emitted, /['"]@mini-harness\//, path + ' depends on a private workspace');
    }
    await execFile(process.execPath, ['--input-type=module', '-e',
      "import 'mini-harness/plugin'; import 'mini-harness/browser-plugin'; import { Context } from 'mini-harness/cordis'; new Context();"], { cwd: installed });
    for (const path of ['sdk/src/plugin.d.ts', 'sdk/src/browser-plugin.d.ts'])
      assert.ok(files.some((file) => file.path === 'dist/types/packages/' + path), 'Missing SDK declarations: ' + path);
    await writeFile(join(installed, 'plugin-types.mts'), `
      import { Context, type Plugin } from 'mini-harness/cordis';
      import { type LlmPort, type ScopeSettings, defineTool } from 'mini-harness/plugin';
      declare module 'mini-harness/cordis' {
        interface Context { example: { greet(name: string): string } }
      }
      declare const ctx: Context;
      const scope: ScopeSettings = { disabledTools: ['write'] };
      const llm: LlmPort | undefined = ctx.harnessLlm;
      const plugin: Plugin = {
        apply(ctx) { ctx.provide('example', { greet: (name: string) => name.toUpperCase() }); }
      };
      ctx.example.greet('world');
      // @ts-expect-error The run scheduler is private.
      ctx.harnessRuns;
      // @ts-expect-error The full session registry is private.
      ctx.harnessRegistry;
      ctx.harnessPluginData.write('state', { count: 1 });
      ctx.harnessPluginSecrets.read('credential');
      ctx.on('internal/update', () => {});
      ctx.on('agent/prepare-input', (content, context) => context.source === 'agent' ? content : undefined);
      ctx.on('agent/model-request', (request) => ({ ...request, systemPrompt: request.systemPrompt.trim() }));
      ctx.effect(() => ctx.harnessPrompt.register({ id: 'status', render: ({ cwd }) => cwd }));
      ctx.on('agent/tool-result', (content) => content);
      ctx.on('harness/observe', (event) => {
        if (event.type === 'run-ended') void event.run.id;
      });
      ctx.on('conversation/tool-projection', ({ content }) => content);
      ctx.on('tools/decide', ({ tool }) => tool === 'change' ? 'deny' : undefined);
      void ctx.harnessSessions.records('session').append({ seen: true });
      // @ts-expect-error Input listeners return native user content or a rejection.
      ctx.on('agent/prepare-input', () => ({ arbitrary: true }));
      void ctx.harnessPluginSettings.set('showDetails', true);
      ctx.harnessPluginRoutes.upgrade('/updates', (_request, socket, _head, signal) => {
        if (signal.aborted) socket.destroy();
      });
      // @ts-expect-error The declared service takes a string.
      ctx.example.greet(1);
      // @ts-expect-error TypeScript plugins declare their own services.
      ctx.undeclared;
      // @ts-expect-error Execution handles own cancellation.
      ctx.harnessExecution.cancel('session');
    `);
    await writeFile(join(installed, 'browser-types.mts'), `
      import { browserPluginSettings, type SlotRenderer } from 'mini-harness/browser-plugin';
      import type { Context } from 'mini-harness/cordis';
      declare module 'mini-harness/browser-plugin' {
        interface SlotMap { 'example.panel': { kind: 'single' } }
      }
      declare const render: SlotRenderer;
      export function apply(ctx: Context) {
        const signal = ctx.fiber.signal;
        ctx.effect(() => ctx.miniSlots.registerKeyed('sidebar.primary', 'example', render));
        ctx.effect(() => ctx.miniSlots.registerKeyed('example.panel', 'example', render));
        // @ts-expect-error A keyed registration needs a renderer.
        ctx.effect(() => ctx.miniSlots.registerKeyed('sidebar.primary', 'example', document.body));
        const model = ctx.miniComposer;
        model.setText('Write a review');
        model.choose({ provider: 'local', id: 'example-model' });
        model.chooseThinking(null);
        void model.setPermission('readOnly');
        void model.addFiles([new File(['text'], 'notes.txt', { type: 'text/plain' })]);
        model.removeAttachment(0);
        model.subscribe(() => model.draft(), signal);
        void model.send();
        // @ts-expect-error The draft snapshot cannot be edited directly.
        model.draft().text = 'Replace this';
        ctx.miniConversation.subscribe(['partial'], () => ctx.miniConversation.get().partial, signal);
        ctx.effect(() => ctx.miniSettingsRegistry.register('example', { id: 'example', section: 'General', render: ({ configuration }) =>
          ctx.miniPrimitives.status(String(configuration.get<boolean>('showDetails')))
        }, browserPluginSettings(ctx)));
      }
    `);
    await Promise.all(['plugin-types.mts', 'browser-types.mts'].map((file) => execFile(process.execPath,
      [resolve('node_modules/typescript/bin/tsc'), '--strict', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', file],
      { cwd: installed })));
    assert.match((await cli('--help')).stdout, /minimal native agent harness/);
    await cp(resolve('docs/examples/task-notes'), plugin, { recursive: true });
    await execFile(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: plugin });
    const settings = readJson<Record<string, unknown>>(paths.settings, {});
    writeJson(paths.settings, { ...settings, plugins: { 'task-notes': true } });
    const launch = await cli('--detached', '--cwd', paths.cwd, '--port', String(await availablePort()));
    assert.match(launch.stdout, /started independently/);
    started = true;
    const info = readServerInfo(paths.pid);
    assert.ok(info);
    const token = /#token=([a-f0-9]{64})/.exec(launch.stdout)?.[1];
    assert.ok(token);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const get = (path: string) => fetch(info.url + path, { headers });
    const write = (path: string, method: string, body: unknown) =>
      fetch(info.url + path, { method, headers, body: JSON.stringify(body) });
    for (const asset of ['/', '/packages/ui-runtime/src/browser/boot.js', '/packages/sdk/src/browser-plugin.js',
      '/packages/ui-primitives/src/browser/vendor/marked.js', '/packages/ui-primitives/src/browser/vendor/purify.js',
      '/logo.svg', '/manifest.webmanifest', '/startup.css', '/icon-192.png', '/icon-512.png', '/favicon.ico']) {
      const response = await get(asset);
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
    const plugins = await (await get('/api/plugins')).json();
    assert.ok(plugins.some(({ id, state }: { id: string; state: string }) => id === 'task-notes' && state === 'ready'));
    assert.deepEqual(await (await get('/api/extensions/task-notes/smoke')).json(), { label: 'Task progress', ready: true, credential: false });
    const patchLabel = (label: string) => write('/api/settings/plugins/task-notes', 'PATCH', { label });
    assert.equal((await patchLabel('   ')).status, 400);
    assert.equal((await patchLabel('Progress update')).status, 200);
    const secret = 'installed-fixture-token';
    const credential = await write('/api/extensions/task-notes/credential', 'PUT', { token: secret });
    assert.equal(credential.status, 200);
    assert.deepEqual(await credential.json(), { credential: true });
    assert.deepEqual(await (await get('/api/extensions/task-notes/smoke')).json(),
      { label: 'Progress update', ready: true, credential: true });
    const bootstrap: import('@mini-harness/ui-runtime/bootstrap').BrowserBootstrap = await (await get('/api/bootstrap')).json();
    assert.doesNotMatch(JSON.stringify(bootstrap), new RegExp(secret));
    assert.equal(bootstrap.ui.find(({ id }) => id === 'task-notes')?.config.label, 'Progress update');
    for (const { browser, styles } of bootstrap.ui) {
      if (browser) assert.equal((await get(browser)).status, 200, browser);
      for (const path of styles ?? []) {
        const css = await get(path);
        assert.equal(css.status, 200, path);
        assert.match(css.headers.get('content-type') ?? '', /^text\/css/);
        await css.arrayBuffer();
      }
    }
    assert.ok(bootstrap.ui.some(({ id }: { id: string }) => id === 'core:conversation'));
    assert.ok(!bootstrap.ui.some(({ id }: { id: string }) => id === 'shell'));
    const item = await (await fetch(info.url + '/api/sessions', { method: 'POST', headers, body: '{}' })).json();
    const url = info.url + '/api/sessions/' + item.id;
    const startedRun = await fetch(url + '/runs', { method: 'POST', headers, body: JSON.stringify({ message: 'Pack smoke test' }) });
    assert.equal(startedRun.status, 202);
    const run = await startedRun.json();
    const chat = await fetch(url + '/events?run=' + run.id, { headers });
    assert.match(await chat.text(), /Mock response/);
    assert.match(JSON.stringify(mock.requests[0]?.messages), /Task notes are available/);
    const status = await (await fetch(url + '/runs', { headers })).json();
    assert.equal(status.run.state, 'completed');
    const conversation = await (await fetch(url, { headers })).json();
    assert.deepEqual(conversation.records.map(({ title, content }: { title: string; content: string }) => ({ title, content })),
      [{ title: 'Progress update', content: 'Installed SDK recorded progress' }]);
    const followUp = write('/api/extensions/task-notes/follow-up', 'POST',
      { parentId: item.id, message: 'Follow up', requireApproval: true });
    void followUp.catch(() => {});
    const approvals = await waitUntil(async () => {
      const response = await get('/api/approvals');
      return await response.json() as { id: string; sessionId: string; plugin: string }[];
    }, (pending) => pending.length === 1);
    const [approval] = approvals;
    assert.equal(approval.sessionId, item.id);
    assert.equal(approval.plugin, 'task-notes');
    assert.equal((await write('/api/approvals', 'POST', { id: approval.id, allow: true })).status, 200);
    const response = await followUp;
    assert.equal(response.status, 200);
    const child = await response.json();
    assert.equal(child.state, 'completed');
    assert.equal(child.text, 'Mock response');
    assert.equal((await (await get('/api/sessions/' + child.childId)).json()).parentId, item.id);

    assert.equal((await write('/api/settings', 'PATCH', { plugins: { 'task-notes': false } })).status, 200);
    assert.equal((await get('/api/extensions/task-notes/smoke')).status, 404);
    const withoutPlugin = await (await get('/api/bootstrap')).json() as typeof bootstrap;
    assert.ok(!withoutPlugin.ui.some(({ id }) => id === 'task-notes'));
    assert.deepEqual((await (await get('/api/sessions/' + item.id)).json()).records, conversation.records);

    assert.match((await cli('status')).stdout, /is running/);
    assert.match((await cli('stop')).stdout, /stopped/);
    started = false;
    console.log(filename + ' passed clean installation, CLI, browser assets and native agent smoke checks');
  } finally {
    if (started) await cli('stop').catch(() => {});
    await mock.close();
    await Promise.all([rm(work, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  }
}

await checkPackage();
