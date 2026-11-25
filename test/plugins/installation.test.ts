import { fixture } from '../support/api-fixture.ts';
import { expectPresent } from '../support/required.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { parse } from 'yaml';
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
      npm_config_ignore_scripts: 'true',
    };
    const run = (...args: string[]) =>
      execFile(process.execPath, [cli, 'plugin', '--profile', 'web', ...args], {
        env,
        cwd: paths.cwd,
        timeout: 12000,
      });

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
        exports: files['index.js']
          ? './index.js'
          : {
              ...(files['server/entry.mjs'] ? { '.': './server/entry.mjs' } : {}),
              ...(files['web/main.js'] ? { './client': './web/main.js' } : {}),
            },
        scripts: { postinstall: "node -e \"require('node:fs').writeFileSync('installed-by-npm', 'yes')\"" },
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
      'server/entry.mjs': `
export const inject = ["harnessPluginRoutes"];
import { label } from 'mini-setup-helper';
export const apply = (ctx) => { ctx.harnessPluginRoutes.register('GET', '/label', () => label); };
`,
      'web/main.js': "export const inject = ['miniPages']; export function apply() {}",
      'web/panel.css': '.panel { color: inherit; }',
      'private.js': 'export const privateValue = "not published";',
      'web/chunks/feature.mjs': 'export const feature = true;',
    };
    await publish('mini-setup-helper', '1.0.0', {
      'index.js': 'export const label = "From dependency";',
    });
    await publish(name, '1.0.0', files, { 'mini-setup-helper': '1.0.0' });
    await run('add', name + '@latest', '--no-audit', '--no-fund');
    const directory = join(paths.home, 'profiles', 'web');
    const added = parse(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8'));
    assert.deepEqual(added.plugins, []);
    let lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/mini-setup-helper'].version, '1.0.0');
    assert.equal(lock.packages['node_modules/' + name].version, '1.0.0');
    assert.ok(!existsSync(join(directory, 'node_modules', name, 'installed-by-npm')));
    await publish(name, '1.1.0', files, { 'mini-setup-helper': '1.0.0' });
    await run('add', name + '@1.1.0', '--no-audit', '--no-fund', '--ignore-scripts');
    lock = JSON.parse(readFileSync(join(directory, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/' + name].version, '1.1.0');
    assert.ok(!existsSync(join(directory, 'node_modules', name, 'installed-by-npm')));
    assert.deepEqual(parse(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')), added);
    writeJson(join(directory, 'cordis.patch.yml'), {
      plugins: [
        {
          id,
          name,
          client: true,
          disabled: true,
          config: { greeting: 'preserved', secret: 'server-only-value' },
        },
      ],
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
    const response = await request('/settings', 'PATCH', { entries: { [id]: { disabled: false } } });
    assert.equal(response.status, 200, await response.text());
    assert.equal(await (await request('/extensions/' + id + '/label')).json(), 'From dependency');
    const bootstrap = await (await request('/bootstrap')).json();
    const entry = bootstrap.ui.find((entry: { id: string }) => entry.id === id);
    assert.deepEqual(entry.config, {});
    assert.doesNotMatch(JSON.stringify(bootstrap), /server-only-value/);
    assert.doesNotMatch(await (await request('/settings')).text(), /server-only-value/);
    assert.doesNotMatch(await (await request('/plugins')).text(), /server-only-value/);
    const asset = (path: string) => fetch('http://127.0.0.1:' + port + path);
    assert.equal(await (await asset(entry.browser)).text(), files['web/main.js']);
    const css = await asset(entry.styles[0]);
    assert.match(css.headers.get('Content-Type') ?? '', /^text\/css/);
    assert.equal(await css.text(), files['web/panel.css']);
    assert.equal((await asset(entry.browser.replace(/web\/main\.js$/, 'private.js'))).status, 404);
    assert.equal(
      await (await asset(entry.browser.replace(/main\.js$/, 'chunks/feature.mjs'))).text(),
      files['web/chunks/feature.mjs'],
    );
    assert.equal(
      (await request('/settings', 'PATCH', { entries: { [id]: { disabled: true } } })).status,
      200,
    );
    assert.equal((await asset(entry.browser)).status, 404);
    assert.equal((await asset(entry.styles[0])).status, 404);
    const standalone = 'npm-client';
    assert.equal((await request('/settings', 'PATCH', { entries: {
      [standalone]: { name: name + '/client', config: { label: 'independent client' } },
    } })).status, 200);
    const independent = (await (await request('/bootstrap')).json()).ui.find((item: { id: string }) => item.id === standalone);
    assert.deepEqual(independent.config, { label: 'independent client' });
    assert.equal((await asset(independent.browser)).status, 200);
    assert.equal((await request('/extensions/' + id + '/label')).status, 404);
    await app.close();
    app = undefined;
    await run('remove', name, '--no-audit', '--no-fund');
    // npm dependency operations do not mutate the explicit Profile composition.
    assert.equal(parse(readFileSync(join(directory, 'cordis.patch.yml'), 'utf8')).plugins[0].name, name);
    const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    assert.equal(manifest.dependencies?.[name], undefined);
    assert.ok(!existsSync(join(directory, 'node_modules', name)));
  },
);

test('local modules mount and unmount without a separate installer', async (t) => {
  const { paths, request, base } = await fixture(t);
  const folder = join(paths.plugins, 'local-module');
  mkdirSync(folder);
  writeJson(join(folder, 'plugin.json'), {});
  writeFileSync(
    join(folder, 'plugin.js'),
    `
export const inject = ['harnessPluginRoutes'];
export function apply(ctx, config) {
  ctx.harnessPluginRoutes.register('POST', '/echo', async ({ body }) => ({ echo: await body() }));
  if (config.fail) throw new Error('Setup failed after registering a route');
}
`,
  );
  writeFileSync(join(folder, 'web.js'), 'export function apply() {}');
  const route = '/extensions/local-module/echo';
  const id = 'local-module';
  assert.equal((await request(route, 'POST', { value: 1 })).status, 404);
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { [id]: { name: '../../plugins/local-module', disabled: false } },
      })
    ).status,
    200,
  );
  const browser = (await request('/bootstrap')).body.ui.find(
    (entry: { id: string }) => entry.id === id,
  ).browser;
  assert.match(await (await fetch(base + browser)).text(), /function/);
  assert.deepEqual((await request(route, 'POST', { value: 1 })).body, { echo: { value: 1 } });
  const failure = await request('/settings', 'PATCH', { entries: { [id]: { config: { fail: true } } } });
  assert.equal(failure.status, 400);
  assert.match(failure.body.error, /Setup failed after registering a route/);
  assert.deepEqual((await request(route, 'POST', { value: 2 })).body, { echo: { value: 2 } });
  assert.equal((await request('/settings', 'PATCH', { entries: { [id]: { disabled: true } } })).status, 200);
  assert.equal((await request(route, 'POST', { value: 2 })).status, 404);
  assert.equal((await fetch(base + browser)).status, 404);
  assert.ok(existsSync(folder));
});

test('browser entries receive and edit their configuration without a field allowlist', async (t) => {
  const { paths, request } = await fixture(t);
  const folder = join(paths.plugins, 'config-visibility');
  mkdirSync(folder);
  writeFileSync(join(folder, 'web.js'), 'export default () => {}');
  writeFileSync(
    join(folder, 'plugin.js'),
    "import { defineConfig } from 'mini-harness/configuration';\nimport { readFileSync } from 'node:fs';\nexport const Config = defineConfig(JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8')));\n",
  );
  writeFileSync(
    join(folder, 'schema.json'),
    JSON.stringify({
      type: 'object',
      properties: {
        label: { type: 'string', default: 'Visible' },
        detail: { type: 'string', default: 'Original' },
      },
    }),
  );
  writeJson(join(folder, 'plugin.json'), {});
  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { 'config-visibility': { name: '../../plugins/config-visibility', disabled: false } },
      })
    ).status,
    200,
  );
  const entry = async () =>
    (await request('/bootstrap')).body.ui.find(({ id }: { id: string }) => id === 'config-visibility');
  assert.deepEqual((await entry()).config, { label: 'Visible', detail: 'Original' });
  assert.equal(
    (await request('/settings/plugins/config-visibility', 'PATCH', { detail: 'Updated' })).status,
    200,
  );
  assert.deepEqual((await entry()).config, { label: 'Visible', detail: 'Updated' });
});
