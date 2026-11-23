import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readServerInfo } from '@mini-harness/host/process';
import { parseNpmPackResult } from './npm-pack.js';
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

async function installExample(work: string, installed: string, tarball: string, env: NodeJS.ProcessEnv) {
  const directory = join(work, 'external-plugin');
  await cp(resolve('examples/remote-web'), directory, { recursive: true, filter: (source) =>
    !/(?:^|[\\/])node_modules(?:[\\/]|$)/.test(source) });
  const manifestPath = join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.devDependencies['mini-harness'] = tarball;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await npm(['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund'], { cwd: directory });
  const result = await npm(['pack', '--json'], { cwd: directory });
  const { filename, files } = parseNpmPackResult(result.stdout);
  assert.ok(files.some(({ path }) => path === 'web/style.css'));
  assert.ok(files.every(({ path }) => !path.startsWith('src/') && !path.endsWith('tsconfig.json')));
  const bytes = await readFile(join(directory, filename));
  let origin: string;
  const registry = httpServer((req, res) => {
    const path = decodeURIComponent(req.url ?? '/');
    if (path === '/remote-web.tgz') { res.end(bytes); return; }
    if (path !== '/' + manifest.name) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ name: manifest.name, 'dist-tags': { latest: manifest.version }, versions: {
      [manifest.version]: { ...manifest, dist: { tarball: origin + '/remote-web.tgz',
        integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') } }
    } }));
  });
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
  try {
    const address = registry.address();
    assert.ok(address && typeof address === 'object');
    origin = 'http://127.0.0.1:' + address.port;
    const npmrc = join(work, '.npmrc');
    await writeFile(npmrc, '@mini-harness-examples:registry=' + origin + '\n');
    await execFile(process.execPath, [join(installed, 'node_modules', 'mini-harness', 'dist', 'bin', 'mini-harness.js'),
      'plugin', 'install', 'remote-web', manifest.name], {
      cwd: installed, env: { ...env, npm_config_userconfig: npmrc }, timeout: 120000
    });
  } finally {
    registry.closeAllConnections();
    await new Promise<void>((done) => registry.close(() => done()));
  }
}

async function verifyRemoteBrowser(pair: () => Promise<Response>) {
  if (process.env.MINI_HARNESS_PACK_BROWSER !== '1') return;
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  try {
    for (const [width, colorScheme] of [[1920, 'light'], [390, 'dark']] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme });
      try {
        const link = await pair();
        assert.equal(link.status, 200);
        const { url } = await link.json();
        await page.goto(url);
        await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
}

async function exerciseGateway(origin: string, headers: Record<string, string>) {
  const selector = '/api/extensions/remote-web';
  const update = (value: object) => fetch(origin + '/api/settings', { method: 'PATCH', headers, body: JSON.stringify(value) });
  const port = await availablePort();
  const enabled = await update({ plugins: { 'remote-web': true }, pluginConfig: { 'remote-web': { port } } });
  assert.equal(enabled.status, 200, await enabled.text());
  const gateway = 'http://127.0.0.1:' + port;
  assert.equal((await fetch(gateway + '/api/bootstrap')).status, 401);
  const pairLink = () => fetch(origin + selector + '/pair', { method: 'POST', headers });
  await verifyRemoteBrowser(pairLink);
  const pair = await pairLink();
  assert.equal(pair.status, 200, await pair.clone().text());
  const { url, qr } = await pair.json();
  assert.match(qr, /<svg/);
  const code = new URLSearchParams(new URL(url).hash.slice(1)).get('code');
  const exchange = () => fetch(gateway + '/pair', { method: 'POST', headers: { Origin: gateway, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }) });
  const paired = await exchange();
  assert.equal(paired.status, 201, await paired.clone().text());
  const { token } = await paired.json();
  assert.notEqual('Bearer ' + token, headers.Authorization);
  assert.equal((await exchange()).status, 401, 'Pairing codes are single use');
  const remote = { Authorization: 'Bearer ' + token };
  assert.equal((await fetch(gateway + '/', { headers: { Cookie: 'mini-harness-remote=' + token } })).status, 200);
  assert.equal((await fetch(gateway + '/api/bootstrap', { headers: remote })).status, 200);
  assert.equal((await fetch(gateway + '/api/workspaces/directories', { headers: remote })).status, 403);
  assert.equal((await fetch(gateway + '/api/settings', { method: 'PATCH', headers: remote, body: '{}' })).status, 403);
  const graph = await (await fetch(origin + '/api/bootstrap', { headers })).json();
  const entry = graph.ui.find(({ id }: { id: string }) => id === 'remote-web');
  assert.equal((await fetch(origin + entry.styles[0])).status, 200);
  assert.equal((await fetch(origin + entry.browser.replace(/web\.js$/, 'plugin.js'))).status, 404);
  const live = await fetch(gateway + '/api/changes', { headers: remote });
  const reader = live.body?.getReader();
  assert.ok(reader);
  assert.equal((await reader.read()).done, false);
  const status = await (await fetch(origin + selector + '/devices', { headers })).json();
  assert.equal(status.devices.length, process.env.MINI_HARNESS_PACK_BROWSER === '1' ? 3 : 1);
  const changed = await update({ pluginConfig: { 'remote-web': { lifetimeMinutes: 30 } } });
  assert.equal(changed.status, 200, await changed.text());
  const id = status.devices.at(-1).id;
  const revoked = await fetch(origin + selector + '/device?id=' + id, { method: 'DELETE', headers });
  assert.equal(revoked.status, 200);
  await assert.rejects(reader.read(), /terminated|aborted|socket|closed/i);
  assert.equal((await fetch(gateway + '/api/bootstrap', { headers: remote })).status, 401);
  const disabled = await update({ plugins: { 'remote-web': false } });
  assert.equal(disabled.status, 200, await disabled.text());
  assert.equal((await fetch(origin + entry.browser)).status, 404);
  const removed = await fetch(origin + '/api/plugins/remote-web', { method: 'DELETE', headers });
  assert.equal(removed.status, 200);
}

async function checkPackage() {
  const work = await mkdtemp(join(process.env.RUNNER_TEMP || tmpdir(), 'mini-harness-pack-'));
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const installed = join(work, 'install');
  const env = { ...process.env, MINI_HARNESS_HOME: paths.home };
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
    const fixture = { name: 'mini-harness-install-check', private: true, version: '0.0.0', dependencies: { [name]: tarball } };
    await writeFile(join(installed, 'package.json'), JSON.stringify(fixture));
    console.log('Installing ' + filename + ' and its production dependencies with npm');
    await npm(['install', '--prefer-offline', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: installed, timeout: 240000
    });
    const published = join(installed, 'node_modules', name);
    const manifest = JSON.parse(await readFile(join(published, 'package.json'), 'utf8'));
    assert.doesNotMatch(JSON.stringify(manifest), /@mini-harness\/|workspace:\*/);
    for (const { path } of files.filter(({ path }) => /\.(?:js|d\.ts)$/.test(path))) {
      const emitted = await readFile(join(published, path), 'utf8');
      assert.doesNotMatch(emitted, /['"]@mini-harness\//, path + ' depends on a private workspace');
    }
    await execFile(process.execPath, ['--input-type=module', '-e',
      "import 'mini-harness/plugin'; import 'mini-harness/browser-plugin';"], { cwd: installed });
    for (const path of ['contracts/plugin-sdk.d.ts', 'ui-runtime/plugin-sdk.d.ts'])
      assert.ok(files.some((file) => file.path === 'dist/types/packages/' + path), 'Missing SDK declarations: ' + path);
    await writeFile(join(installed, 'plugin-types.mts'), `
      import type { PluginApi, LlmPort } from 'mini-harness/plugin';
      import type { FrontendApi, SlotRenderer } from 'mini-harness/browser-plugin';
      declare module 'mini-harness/plugin' {
        interface ServiceMap { example: { greet(name: string): string } }
      }
      declare const api: PluginApi;
      const llm: LlmPort | undefined = api.service('harnessLlm');
      api.provide('example', { greet: (name) => name.toUpperCase() });
      api.service('example')?.greet('world');
      // @ts-expect-error The declared service takes a string.
      api.service('example')?.greet(1);
      // @ts-expect-error TypeScript plugins declare their own services.
      api.service('undeclared');
      declare const frontend: FrontendApi, render: SlotRenderer;
      frontend.slots.registerKeyed('sidebar.primary', 'example', render);
    `);
    await execFile(process.execPath, [resolve('node_modules/typescript/bin/tsc'),
      '--strict', '--skipLibCheck', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', 'plugin-types.mts'],
    { cwd: installed });
    assert.match((await cli('--help')).stdout, /minimal native agent harness/);
    const launch = await cli('--detached', '--cwd', paths.cwd, '--port', String(await availablePort()));
    assert.match(launch.stdout, /started independently/);
    started = true;
    const info = readServerInfo(paths.pid);
    assert.ok(info);
    const token = /#token=([a-f0-9]{64})/.exec(launch.stdout)?.[1];
    assert.ok(token);
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    const get = (path: string) => fetch(info.url + path, { headers });
    for (const asset of ['/', '/packages/ui-runtime/boot.js', '/packages/ui-primitives/markdown.js', '/packages/session-helper/client.js', '/packages/settings/browser.js', '/packages/sessions/browser/conversation/view.js', '/packages/ui-primitives/primitives.js', '/packages/web/vendor/marked.js', '/packages/web/vendor/purify.js', '/logo.svg', '/manifest.webmanifest', '/theme.css', '/icon-192.png', '/icon-512.png', '/favicon.ico']) {
      const response = await get(asset);
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
    const plugins = await (await get('/api/plugins')).json();
    assert.deepEqual(plugins.map(({ id }: { id: string }) => id), ['files', 'skills', 'subagents', 'shell', 'session-helper']);
    const bootstrap = await (await get('/api/bootstrap')).json();
    assert.ok(bootstrap.ui.some(({ id }: { id: string }) => id === 'core:conversation'));
    assert.ok(!bootstrap.ui.some(({ id }: { id: string }) => id === 'shell'));
    const item = await (await fetch(info.url + '/api/sessions', { method: 'POST', headers, body: '{}' })).json();
    const url = info.url + '/api/sessions/' + item.id;
    const startedRun = await fetch(url + '/runs', { method: 'POST', headers, body: JSON.stringify({ message: 'Pack smoke test' }) });
    assert.equal(startedRun.status, 202);
    const run = await startedRun.json();
    const chat = await fetch(url + '/events?run=' + run.id, { headers });
    assert.match(await chat.text(), /Mock response/);
    const status = await (await fetch(url + '/runs', { headers })).json();
    assert.equal(status.run.state, 'completed');
    assert.match((await cli('status')).stdout, /is running/);
    assert.match((await cli('stop')).stdout, /stopped/);
    started = false;
    await installExample(work, installed, tarball, env);
    const reference = await cli('--detached', '--cwd', paths.cwd, '--port', String(await availablePort()));
    started = true;
    const refInfo = readServerInfo(paths.pid);
    const refToken = /#token=([a-f0-9]{64})/.exec(reference.stdout)?.[1];
    assert.ok(refInfo && refToken);
    await exerciseGateway(refInfo.url, { Authorization: 'Bearer ' + refToken, 'Content-Type': 'application/json' });
    assert.match((await cli('stop')).stdout, /stopped/);
    started = false;
    console.log('Independent Remote Web package installed, paired, reconfigured, revoked and uninstalled.');
    console.log(filename + ' passed clean installation, CLI, browser assets and native agent smoke checks');
  } finally {
    if (started) await cli('stop').catch(() => {});
    await mock.close();
    await Promise.all([rm(work, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  }
}

await checkPackage();
