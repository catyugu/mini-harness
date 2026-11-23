import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readServerInfo } from '../packages/host/process.js';
import { createFixturePaths, createMockProvider } from '../test/helpers/mock-provider.js';

const execFile = promisify(exec);
const npmPath = process.env.npm_execpath;
if (!npmPath) throw new Error('Run npm run pack:check');
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
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const installed = join(work, 'install');
  const env = { ...process.env, MINI_HARNESS_HOME: paths.home };
  let started = false;
  const cli = (...args: string[]) => npm(['exec', '--offline', '--', 'mini-harness', ...args], { cwd: installed, env });
  try {
    const packed = await npm(['pack', '--json', '--pack-destination', work], { cwd: resolve('.') });
    const [{ name, filename, integrity, files }] = JSON.parse(packed.stdout);
    assert.ok(files.every(({ path }: { path: string }) =>
      !/^dist\/(?:scripts|test)\//.test(path) &&
      !/^dist\/packages\/[^/]+\/package\.json$/.test(path) &&
      !/^dist\/.*\/tests\//.test(path) &&
      !/\.(?:test|spec)\.js$/.test(path)), 'Published package must exclude test artifacts');
    await mkdir(installed);
    const source = JSON.parse(await readFile('package-lock.json', 'utf8'));
    const tarball = 'file:../' + filename;
    const fixture = { name: 'mini-harness-install-check', version: '0.0.0', dependencies: { [name]: tarball } };
    const { version, license, dependencies, bin, engines } = source.packages[''];
    // Install the tarball into an empty project while keeping the tested dependency resolutions.
    const lock = {
      name: fixture.name, version: fixture.version, lockfileVersion: source.lockfileVersion, requires: true,
      packages: {
        ...source.packages,
        '': fixture,
        ['node_modules/' + name]: { version, resolved: tarball, integrity, license, dependencies, bin, engines }
      }
    };
    await writeFile(join(installed, 'package.json'), JSON.stringify({ ...fixture, private: true }));
    await writeFile(join(installed, 'package-lock.json'), JSON.stringify(lock));
    const networkPolicy = process.env.CI === 'true' ? '--offline' : '--prefer-offline';
    console.log('Installing ' + filename + ' and its locked production dependencies');
    await npm(['ci', networkPolicy, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: installed, timeout: 240000
    });
    await execFile(process.execPath, ['--input-type=module', '-e',
      "import 'mini-harness/plugin'; import 'mini-harness/browser-plugin';"], { cwd: installed });
    for (const path of ['contracts/plugin-sdk.d.ts', 'ui-runtime/plugin-sdk.d.ts'])
      assert.ok(files.some((file) => file.path === 'dist/types/packages/' + path), 'Missing SDK declarations: ' + path);
    assert.match((await cli('--help')).stdout, /minimal native agent harness/);
    const launch = await cli('--detached', '--cwd', paths.cwd, '--port', String(await availablePort()));
    assert.match(launch.stdout, /started independently/);
    started = true;
    const info = readServerInfo(paths.pid);
    assert.ok(info);
    const headers = { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' };
    const get = (path: string) => fetch(info.url + path, { headers });
    for (const asset of ['/', '/packages/ui-runtime/boot.js', '/packages/ui-primitives/markdown.js', '/packages/session-helper/client.js', '/packages/settings/browser.js', '/packages/sessions/browser/conversation/view.js', '/packages/ui-primitives/primitives.js', '/packages/web/vendor/marked.js', '/packages/web/vendor/purify.js', '/logo.svg', '/manifest.webmanifest', '/theme.css', '/icon-192.png', '/icon-512.png', '/favicon.ico']) {
      const response = await get(asset);
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
    const plugins = await (await get('/api/plugins')).json();
    assert.deepEqual(plugins.map(({ id }) => id), ['files', 'skills', 'subagents', 'shell', 'session-helper']);
    const bootstrap = await (await get('/api/bootstrap')).json();
    assert.ok(bootstrap.ui.some(({ id }) => id === 'core:conversation'));
    assert.ok(!bootstrap.ui.some(({ id }) => id === 'shell'));
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
    console.log(filename + ' passed clean installation, CLI, browser assets and native agent smoke checks');
  } finally {
    if (started) await cli('stop').catch(() => {});
    await mock.close();
    await Promise.all([rm(work, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  }
}

await checkPackage();
