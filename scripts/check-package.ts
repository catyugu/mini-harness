import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readServerInfo } from '../src/process.js';
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
  const work = await mkdtemp(join(tmpdir(), 'mini-harness-pack-'));
  const mock = await createMockProvider();
  const { root, paths } = createFixturePaths(mock.url);
  const installed = join(work, 'install');
  const env = { ...process.env, MINI_HARNESS_HOME: paths.home };
  let started = false;
  const cli = (...args: string[]) => npm(['exec', '--offline', '--', 'mini-harness', ...args], { cwd: installed, env });
  try {
    const packed = await npm(['pack', '--json', '--pack-destination', work], { cwd: resolve('.') });
    const [{ filename, files }] = JSON.parse(packed.stdout);
    assert.ok(files.every(({ path }: { path: string }) => !/^dist\/(?:scripts|test)\//.test(path)));
    await mkdir(installed);
    await writeFile(join(installed, 'package.json'), '{"private":true}');
    await npm(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', join(work, filename)], { cwd: installed });
    assert.match((await cli('--help')).stdout, /minimal Pi harness/);
    const launch = await cli('--detached', '--cwd', paths.cwd, '--port', String(await availablePort()));
    assert.match(launch.stdout, /started independently/);
    started = true;
    const info = readServerInfo(paths.pid);
    assert.ok(info);
    const headers = { Authorization: 'Bearer ' + info.token, 'Content-Type': 'application/json' };
    const get = (path: string) => fetch(info.url + path, { headers });
    for (const asset of ['/', '/app.js', '/markdown.js', '/vendor/marked.js', '/vendor/purify.js', '/logo.svg', '/manifest.webmanifest', '/style.css']) {
      const response = await get(asset);
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
    const bootstrap = await (await get('/api/bootstrap')).json();
    assert.deepEqual(bootstrap.plugins.map(({ id }) => id), ['skills', 'subagents', 'shell']);
    const item = await (await fetch(info.url + '/api/sessions', { method: 'POST', headers, body: '{}' })).json();
    const url = info.url + '/api/sessions/' + item.id + '/messages';
    const chat = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ message: 'Pack smoke test' }) });
    assert.match(await chat.text(), /"complete","text":"Mock response"/);
    assert.match((await cli('status')).stdout, /is running/);
    assert.match((await cli('stop')).stdout, /stopped/);
    started = false;
    console.log(filename + ' passed clean installation, CLI, browser assets and real Pi smoke checks');
  } finally {
    if (started) await cli('stop').catch(() => {});
    await mock.close();
    await Promise.all([rm(work, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]);
  }
}

await checkPackage();
