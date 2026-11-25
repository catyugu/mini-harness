import { fixture, waitUntil } from '../support/api-fixture.ts';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writeJson } from '@mini-harness/platform/json';
import { createMiniHarnessServer } from '../support/profile.ts';
import { createFixturePaths } from '../helpers/mock-provider.ts';
import { parseNpmPackResult } from '../../scripts/npm-pack.ts';

const execFile = promisify(exec);
const npmCli =
  process.env.MINI_HARNESS_NPM_CLI ??
  resolve(
    dirname(process.execPath),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  );
const cli = resolve('dist/bin/mini-harness.js');

test('npm pack output accepts both array and npm 12 keyed objects', () => {
  const result = { name: 'probe-pkg', filename: 'probe-pkg-1.0.0.tgz', files: [{ path: 'package.json' }] };
  assert.deepEqual(parseNpmPackResult(JSON.stringify([result])), result);
  assert.deepEqual(parseNpmPackResult(JSON.stringify({ 'probe-pkg': result })), result);
  const { name: _name, ...keyed } = result;
  assert.deepEqual(parseNpmPackResult(JSON.stringify({ 'probe-pkg': keyed })), result);
  assert.throws(() => parseNpmPackResult('{}'), /Unexpected npm pack output/);
  assert.throws(
    () => parseNpmPackResult(JSON.stringify({ probe: { filename: '../unsafe.tgz' } })),
    /Unexpected npm pack output/,
  );
});

test(
  'Profile npm dependencies resolve ordinary modules and browser build output',
  { timeout: 45000 },
  async (t) => {
    const { paths, root } = createFixturePaths('http://127.0.0.1:1/v1');
    const packages = new Map<string, { version: string; bytes: Buffer; manifest: object }[]>();
    const tarballs = new Map<string, Buffer>();
    let origin: string;
    const registry = createServer((req, res) => {
      const path = decodeURIComponent(req.url ?? '/');
      const versions = packages.get(path.slice(1));
      const tarball = tarballs.get(path);
      if (tarball) return res.end(tarball);
      if (!versions) {
        res.writeHead(404);
        return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(
        JSON.stringify({
          name: path.slice(1),
          'dist-tags': { latest: expectPresent(versions.at(-1), 'published package version').version },
          versions: Object.fromEntries(
            versions.map(({ version, manifest, bytes }) => [
              version,
              {
                ...manifest,
                dist: {
                  tarball: origin + path + '/-/' + version + '.tgz',
                  integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
                },
              },
            ]),
          ),
        }),
      );
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
    const env = {
      ...process.env,
      MINI_HARNESS_HOME: paths.home,
      npm_config_registry: origin,
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_fetch_retries: '0',
      npm_config_prefer_online: 'true',
    };
    const run = (...args: string[]) =>
      execFile(process.execPath, [cli, 'plugin', '--profile', 'web', ...args], { env, cwd: paths.cwd, timeout: 12000 });

    async function publish(
      name: string,
      version: string,
      files: Record<string, string>,
      dependencies?: object,
    ) {
      const cwd = join(root, 'fixture-' + name.split('/').at(-1) + '-' + version);
      mkdirSync(cwd);
      const manifest = {
        name,
        version,
        type: 'module',
        dependencies,
        exports: files['index.js'] ? './index.js' : files['server/entry.mjs'] ? './server/entry.mjs' : undefined,
        scripts: { postinstall: 'node -e "process.exit(13)"' },
      };
      writeJson(join(cwd, 'package.json'), manifest);
      for (const [file, source] of Object.entries(files)) {
        const target = join(cwd, file);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, source);
      }
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
      'plugin.json': JSON.stringify({
        browser: 'web/main.js',
        browserDirectory: 'web',
        browserPreload: 'web/preload.js',
      }),
      'server/entry.mjs': `
export const inject = ["harnessPluginRoutes"];
import { label } from 'mini-setup-helper';
export const apply = (ctx) => { ctx.harnessPluginRoutes.register('GET', '/label', () => label); };
`,
      'web/main.js': "export const inject = ['miniPages']; export function apply() {}",
      'web/panel.css': '.panel { color: inherit; }',
      'web/preload.js': 'export default (signal) => { signal.throwIfAborted(); };',
      'private.js': 'export const privateValue = "not published";',
      'web/chunks/feature.mjs': 'export const feature = true;',
    };
    await publish('mini-setup-helper', '1.0.0', {
      'index.js': 'export const label = "From dependency";',
    });
    await publish(name, '1.0.0', files, { 'mini-setup-helper': '1.0.0' });
    await run('add', name + '@latest', '--no-audit', '--no-fund');
    const directory = join(paths.home, 'profiles', 'web');
    let lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/mini-setup-helper'].version, '1.0.0');
    assert.equal(lock.packages['node_modules/' + name].version, '1.0.0');
    await publish(name, '1.1.0', files, { 'mini-setup-helper': '1.0.0' });
    await run('add', name + '@1.1.0', '--no-audit', '--no-fund');
    lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/' + name].version, '1.1.0');
    writeJson(join(directory, 'cordis.patch.yml'), {
      plugins: [{ id, name, client: true, disabled: true, config: { greeting: 'preserved' } }],
    });

    app = await createMiniHarnessServer(paths);
    const port = await app.listen(0);
    const headers = { Authorization: 'Bearer ' + app.token, 'Content-Type': 'application/json' };
    const request = (path: string, method = 'GET', body?: object) =>
      fetch('http://127.0.0.1:' + port + '/api' + path, {
        method,
        headers,
        body: JSON.stringify(body),
      });
    const metadata = (await (await request('/plugins')).json()).find(
      (plugin: { id: string }) => plugin.id === id,
    );
    assert.deepEqual(metadata.package, { name, version: '1.1.0' }, metadata.error);
    assert.equal(metadata.state, 'disabled');
    const response = await request('/settings', 'PATCH', { plugins: { [id]: true } });
    assert.equal(response.status, 200, await response.text());
    assert.equal(await (await request('/extensions/' + id + '/label')).json(), 'From dependency');
    const bootstrap = await (await request('/bootstrap')).json();
    const entry = bootstrap.ui.find((entry: { id: string }) => entry.id === id);
    const asset = (path: string) => fetch('http://127.0.0.1:' + port + path);
    assert.equal(await (await asset(entry.browser)).text(), files['web/main.js']);
    const css = await asset(entry.styles[0]);
    assert.match(css.headers.get('Content-Type') ?? '', /^text\/css/);
    assert.equal(await css.text(), files['web/panel.css']);
    assert.equal(await (await asset(entry.preload)).text(), files['web/preload.js']);
    assert.equal((await asset(entry.browser.replace(/web\/main\.js$/, 'private.js'))).status, 404);
    assert.equal(
      await (await asset(entry.browser.replace(/main\.js$/, 'chunks/feature.mjs'))).text(),
      files['web/chunks/feature.mjs'],
    );
    assert.equal((await request('/settings', 'PATCH', { plugins: { [id]: false } })).status, 200);
    assert.equal((await asset(entry.browser)).status, 404);
    assert.equal((await asset(entry.styles[0])).status, 404);
    await app.close();
    app = undefined;
    await run('remove', name, '--no-audit', '--no-fund');
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies?.[name], undefined);
    assert.ok(!existsSync(join(directory, 'node_modules', name)));
  },
);

test('local and browser-only plugins install disabled, mount when enabled and uninstall permanently', async (t) => {
  const { paths, request, base } = await fixture(t);
  const route = '/extensions/gui-plugin/echo';
  const bundle = {
    id: 'gui-plugin',
    files: [
      { name: 'plugin.json', content: JSON.stringify({}) },
      {
        name: 'plugin.js',
        content: `
export const inject = ["harnessPluginRoutes"];
export function apply(ctx, config) {
      ctx.harnessPluginRoutes.register('POST', '/echo', async ({ body }) => ({ echo: await body() }));
      if (config.fail) throw new Error('Setup failed after registering a route');
    }
`,
      },
      { name: 'web.js', content: 'export function apply(ctx) {}' },
    ],
  };
  assert.equal((await request('/plugins/install', 'POST', bundle)).status, 201);
  assert.ok(!(await request('/bootstrap')).body.ui.some((entry: { id: string }) => entry.id === bundle.id));
  assert.equal((await request(route, 'POST', { value: 1 })).status, 404);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'gui-plugin': true } })).status, 200);
  const browser = (await request('/bootstrap')).body.ui.find(
    (entry: { id: string }) => entry.id === bundle.id,
  ).browser;
  assert.match(await (await fetch(base + browser)).text(), /function/);
  assert.deepEqual((await request(route, 'POST', { value: 1 })).body, { echo: { value: 1 } });
  const failure = await request('/settings', 'PATCH', { pluginConfig: { 'gui-plugin': { fail: true } } });
  assert.equal(failure.status, 400);
  assert.match(failure.body.error, /Setup failed after registering a route/);
  assert.deepEqual((await request(route, 'POST', { value: 2 })).body, { echo: { value: 2 } });
  assert.equal((await request('/plugins/gui-plugin', 'DELETE')).status, 409);
  await request('/settings', 'PATCH', { plugins: { 'gui-plugin': false } });
  assert.equal((await request(route, 'POST', { value: 2 })).status, 404);
  assert.equal((await request('/plugins/gui-plugin', 'DELETE')).status, 200);
  assert.equal(existsSync(join(paths.plugins, 'gui-plugin')), false);
  const after = (await request('/settings')).body;
  assert.equal(after.plugins['gui-plugin'], undefined);
  assert.equal(after.pluginConfig['gui-plugin'], undefined);
  assert.equal(
    (await request('/plugins/install', 'POST', { ...bundle, files: [{ name: '../escape.js', content: '' }] }))
      .status,
    400,
  );
  const installWithManifest = (content: string) =>
    request('/plugins/install', 'POST', {
      ...bundle,
      files: [{ name: 'plugin.json', content }, ...bundle.files.slice(1)],
    });
  assert.match((await installWithManifest('[]')).body.error, /Expected an object in plugin.json/);
  assert.match((await installWithManifest('{"scope":"invalid"}')).body.error, /Invalid plugin scope/);
  assert.match(
    (await request('/plugins/install', 'POST', { ...bundle, files: bundle.files.slice(1) })).body.error,
    /Include plugin.json/,
  );
  assert.equal((await request('/bootstrap')).status, 200);
  assert.equal(existsSync(join(paths.plugins, 'gui-plugin')), false);

  assert.equal(
    (
      await request('/plugins/install', 'POST', {
        id: 'browser-only',
        files: [
          { name: 'plugin.json', content: JSON.stringify({}) },
          {
            name: 'web.js',
            content:
              'export const inject = ["miniComposer"];\n\nexport const apply = (ctx) => { ctx.effect(() => ctx.miniComposer.command({name:"browser-only",description:"Test"})); };',
          },
        ],
      })
    ).status,
    201,
  );
  assert.ok(
    !(await request('/bootstrap')).body.ui.some((entry: { id: string }) => entry.id === 'browser-only'),
  );
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'browser-only': true } })).status, 200);
  const webEntry = (await request('/bootstrap')).body.ui.find(
    (entry: { id: string }) => entry.id === 'browser-only',
  ).browser;
  assert.match(await (await fetch(base + webEntry)).text(), /browser-only/);
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'browser-only': false } })).status, 200);
  assert.equal((await fetch(base + webEntry)).status, 404);
  assert.equal((await request('/plugins/browser-only', 'DELETE')).status, 200);
  const settings = (await request('/settings')).body;
  assert.equal(settings.plugins['browser-only'], undefined);
  assert.equal(settings.pluginConfig['browser-only'], undefined);
});

test('plugin file writes wait for an in-flight plugin configuration', async (t) => {
  const { paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'slow-plugin');
  const entered = join(folder, 'entered');
  const release = join(folder, 'release');
  mkdirSync(folder);
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({}));
  writeFileSync(
    join(folder, 'plugin.js'),
    `
import { existsSync, writeFileSync } from 'node:fs';
export const apply = async () => {
      writeFileSync(${JSON.stringify(entered)}, 'ready');
      while (!existsSync(${JSON.stringify(release)})) await new Promise((done) => setTimeout(done, 10));
    };
`,
  );
  const updating = request('/settings', 'PATCH', { plugins: { 'slow-plugin': true } });
  try {
    await waitUntil(() => existsSync(entered), Boolean);
    const installation = await request('/plugins/install', 'POST', {
      id: 'another-plugin',
      files: [{ name: 'plugin.js', content: 'export default () => {};' }],
    });
    assert.equal(installation.status, 409);
    assert.match(installation.body.error, /Configuration is already changing/);
    const removal = await request('/plugins/slow-plugin', 'DELETE');
    assert.equal(removal.status, 409);
    assert.match(removal.body.error, /Configuration is already changing/);
    assert.equal(existsSync(folder), true);
  } finally {
    writeFileSync(release, 'done');
    assert.equal((await updating).status, 200);
  }
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'slow-plugin': false } })).status, 200);
  assert.equal((await request('/plugins/slow-plugin', 'DELETE')).status, 200);
  assert.equal(existsSync(folder), false);
});

test('browser entries receive and edit their configuration without a field allowlist', async (t) => {
  const { paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'config-visibility');
  mkdirSync(folder);
  writeFileSync(join(folder, 'web.js'), 'export default () => {}');
  writeJson(join(folder, 'plugin.json'), {
    configSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', default: 'Visible' },
        detail: { type: 'string', default: 'Original' },
      },
    },
  });
  assert.equal((await request('/settings', 'PATCH', { plugins: { 'config-visibility': true } })).status, 200);
  const entry = async () =>
    (await request('/bootstrap')).body.ui.find(
      ({ id }: { id: string }) => id === 'config-visibility',
    );
  assert.deepEqual((await entry()).config, { label: 'Visible', detail: 'Original' });
  assert.equal((await request('/settings/plugins/config-visibility', 'PATCH', { detail: 'Updated' })).status, 200);
  assert.deepEqual((await entry()).config, { label: 'Visible', detail: 'Updated' });
});
