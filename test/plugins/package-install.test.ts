import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { readSettings, writeJson } from '@mini-harness/platform/config';
import { createMiniHarnessServer } from '@mini-harness/host/server';
import { createFixturePaths } from '../helpers/mock-provider.js';
import { parseNpmPackResult } from '../../scripts/npm-pack.js';

const execFile = promisify(exec);
const npmCli = process.env.MINI_HARNESS_NPM_CLI ?? resolve(dirname(process.execPath),
  process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
const cli = resolve('dist/bin/mini-harness.js');

test('npm pack output accepts both array and npm 12 keyed objects', () => {
  const result = { name: 'probe-pkg', filename: 'probe-pkg-1.0.0.tgz', files: [{ path: 'package.json' }] };
  assert.deepEqual(parseNpmPackResult(JSON.stringify([result])), result);
  assert.deepEqual(parseNpmPackResult(JSON.stringify({ 'probe-pkg': result })), result);
  const { name: _name, ...keyed } = result;
  assert.deepEqual(parseNpmPackResult(JSON.stringify({ 'probe-pkg': keyed })), result);
  assert.throws(() => parseNpmPackResult('{}'), /Unexpected npm pack output/);
  assert.throws(() => parseNpmPackResult(JSON.stringify({ probe: { filename: '../unsafe.tgz' } })),
    /Unexpected npm pack output/);
});

test('pnpm distribution resolves dependencies, updates atomically and serves both entrypoints', { timeout: 45000 }, async (t) => {
  const { paths, root } = createFixturePaths('http://127.0.0.1:1/v1');
  const packages = new Map<string, { version: string; bytes: Buffer; manifest: object }[]>();
  const tarballs = new Map<string, Buffer>();
  let origin: string;
  const registry = createServer((req, res) => {
    const path = decodeURIComponent(req.url);
    const versions = packages.get(path.slice(1));
    const tarball = tarballs.get(path);
    if (tarball) return res.end(tarball);
    if (!versions) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(JSON.stringify({
      name: path.slice(1), 'dist-tags': { latest: versions.at(-1).version },
      versions: Object.fromEntries(versions.map(({ version, manifest, bytes }) => [version, {
        ...manifest,
        dist: { tarball: origin + path + '/-/' + version + '.tgz',
          integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') }
      }]))
    }));
  });
  let app: Awaited<ReturnType<typeof createMiniHarnessServer>> | undefined;
  t.after(async () => {
    await app?.close();
    await new Promise<void>((done) => registry.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  await new Promise<void>((done) => registry.listen(0, '127.0.0.1', done));
  const address = registry.address();
  assert.ok(address && typeof address === 'object');
  origin = 'http://127.0.0.1:' + address.port;
  const env = { ...process.env, MINI_HARNESS_HOME: paths.home, npm_config_registry: origin,
    npm_config_cache: join(root, 'npm-cache'), npm_config_fetch_retries: '0', npm_config_prefer_online: 'true' };
  const run = (...args: string[]) => execFile(process.execPath, [cli, 'plugin', ...args], { env, cwd: paths.cwd, timeout: 12000 });

  async function publish(name: string, version: string, files: Record<string, string>, dependencies?: object) {
    const cwd = join(root, 'fixture-' + name.split('/').at(-1) + '-' + version);
    mkdirSync(cwd);
    const manifest = { name, version, type: 'module', dependencies, main: files['index.js'] ? 'index.js' : undefined,
      scripts: { postinstall: 'node -e "process.exit(13)"' } };
    writeJson(join(cwd, 'package.json'), manifest);
    for (const [file, source] of Object.entries(files)) writeFileSync(join(cwd, file), source);
    const args = ['pack', '--ignore-scripts', '--json'];
    const result = await execFile(process.execPath, [npmCli, ...args], { cwd, env });
    const { filename } = parseNpmPackResult(result.stdout);
    const bytes = readFileSync(join(cwd, filename));
    tarballs.set('/' + name + '/-/' + version + '.tgz', bytes);
    packages.set(name, [...(packages.get(name) ?? []), { version, bytes, manifest }]);
  }

  const name = '@fixture/harness-plugin';
  const id = 'npm-plugin';
  const files = {
    'plugin.json': JSON.stringify({ inject: ['harnessRoutes'] }),
    'plugin.js': `import { label } from 'mini-setup-helper';
      export default (_ctx, api) => api.registerRoute('GET', '/label', () => label);`,
    'web.js': 'export default () => {};'
  };
  await publish('mini-setup-helper', '1.0.0', {
    'index.js': 'export const label = "From dependency";'
  });
  await publish(name, '1.0.0', files, { 'mini-setup-helper': '1.0.0' });
  await assert.rejects(run('install', 'files', name), /Invalid plugin ID/);
  assert.match((await run('install', id, name + '@latest')).stdout, /harness-plugin@1\.0\.0/);
  await publish(name, '1.1.0', files, { 'mini-setup-helper': '1.0.0' });
  assert.match((await run('update', id)).stdout, /harness-plugin@1\.1\.0/);
  const directory = join(paths.plugins, id);
  const installed = readdirSync(directory);
  const source = JSON.parse(readFileSync(join(directory, '.package-source.json'), 'utf8'));
  const lock = readFileSync(join(directory, source.generation, 'pnpm-lock.yaml'), 'utf8');
  assert.match(lock, /mini-setup-helper@1\.0\.0/);
  assert.equal(installed.length, 2);

  const settings = readSettings(paths);
  writeJson(paths.settings, { ...settings, plugins: { [id]: true }, pluginConfig: { [id]: { greeting: 'preserved' } } });
  await assert.rejects(run('update', id), /Disable and save/);
  writeJson(paths.settings, { ...readSettings(paths), plugins: { [id]: false } });

  await publish(name, '1.2.0', { 'plugin.js': files['plugin.js'] }, { 'mini-setup-helper': '1.0.0' });
  await assert.rejects(run('update', id), /Expected an object in plugin\.json/);
  assert.deepEqual(readdirSync(directory), installed);
  assert.equal(readSettings(paths).pluginConfig[id].greeting, 'preserved');

  app = await createMiniHarnessServer(paths);
  const port = await app.listen(0);
  const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
  const request = (path: string, method = 'GET', body?: object) => fetch('http://127.0.0.1:' + port + '/api' + path, {
    method, headers, body: JSON.stringify(body)
  });
  const metadata = (await (await request('/plugins')).json()).find((plugin) => plugin.id === id);
  assert.deepEqual(metadata.package, { name, version: '1.1.0' }, metadata.error);
  assert.equal(metadata.state, 'discovered');
  const response = await request('/settings', 'PATCH', { plugins: { [id]: true } });
  assert.equal(response.status, 200, await response.text());
  assert.equal(await (await request('/extensions/' + id + '/label')).json(), 'From dependency');
  assert.equal((await (await request('/plugins/' + id + '/web')).json()).source, files['web.js']);
  assert.equal((await request('/settings', 'PATCH', { plugins: { [id]: false } })).status, 200);
  const active = join(directory, source.generation);
  const link = join(active, 'node_modules', '@fixture', 'harness-plugin');
  rmSync(link, { recursive: true });
  symlinkSync(paths.cwd, link, 'junction');
  const invalid = (await (await request('/plugins')).json()).find((plugin) => plugin.id === id);
  assert.equal(invalid.state, 'failed');
  assert.match(invalid.error, /outside its installation directory/);
  assert.equal((await request('/plugins/' + id, 'DELETE')).status, 200);
  assert.ok(!readdirSync(paths.plugins).includes(id));
});
