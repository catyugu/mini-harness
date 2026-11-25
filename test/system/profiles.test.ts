import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';
import { writeText, writeJson } from '@mini-harness/platform/json';
import { getPaths, ensurePaths } from '@mini-harness/platform/paths';
import { Context } from 'mini-harness/cordis';
import { allowsDetachment, initializeProfile, loadProfile } from '@mini-harness/host/profile';
import { bootProfile } from '@mini-harness/host/application';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.ts';

test('YAML Profile composes through Cordis and persists Web entry changes', async (t) => {
  const mock = await createMockProvider();
  const { paths, root } = createFixturePaths(mock.url);
  t.after(async () => {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configure = (name: string) => join(paths.home, 'profiles', name, 'cordis.patch.yml');
  writeText(
    configure('web'),
    "plugins:\n  - id: git-diff\n    name: '@mini-harness/git-diff'\n    disabled: true\n",
  );
  const launch = { interactive: false, shutdown() {} };
  const web = await bootProfile('web', paths, launch);
  try {
    assert.equal(web.ctx.harnessProfile.entries.get('git-diff'), undefined);
    assert.ok(web.ctx.get('harnessWeb'));
    assert.ok(web.ctx.get('harnessGateway'));
    assert.ok(web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'files'));
    assert.equal(web.ctx.harnessProfile.entries.get('core:layout'), undefined);
    assert.ok(web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'core:layout'));
    assert.ok(!web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'git-diff'));
    assert.doesNotMatch(readFileSync(paths.settings, 'utf8'), /pluginConfig|providers|"plugins"/);
    await web.ctx.harnessSettingsStore.update({ plugins: { 'core:layout': false } });
    assert.ok(!web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'core:layout'));
    await web.ctx.harnessSettingsStore.update({ plugins: { 'core:layout': true } });
    assert.ok(web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'core:layout'));
    await web.ctx.harnessSettingsStore.update({ plugins: { 'file-preview': false } });
    assert.match(readFileSync(configure('web'), 'utf8'), /id: file-preview\s+disabled: true/);
  } finally {
    await web.close();
  }

  const reopened = await bootProfile('web', paths, launch);
  try {
    assert.equal(reopened.ctx.harnessProfile.entries.get('file-preview'), undefined);
    assert.ok(reopened.ctx.harnessProfile.entries.get('files')?.active);
    const session = reopened.ctx.harnessRegistry.create();
    assert.equal(await reopened.ctx.harnessRuns.send(session.id, 'Profile after restart'), 'Mock response');
  } finally {
    await reopened.close();
  }

  writeText(configure('web'), 'plugins:\n  - id: files\n    disabled: !!js arbitrary()\n');
  await assert.rejects(bootProfile('web', paths, launch), /cordis\.patch\.yml.*tag/is);
});

test('custom Profiles load native local and npm entries without the plugin manager', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = getPaths(root, { MINI_HARNESS_HOME: join(root, 'home') });
  ensurePaths(paths);
  const directory = initializeProfile('custom', paths);
  const file = join(directory, 'cordis.patch.yml');
  const bundle = join(directory, 'node_modules', 'profile-bundle');
  const fragment = join(bundle, 'provider.yml');
  writeJson(join(bundle, 'package.json'), {
    name: 'profile-bundle',
    type: 'module',
    miniHarness: { bundle: { patch: './provider.yml' } },
  });
  const manifest = join(directory, 'package.json');
  const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
  metadata.dependencies = { 'profile-bundle': '1.0.0', 'profile-consumer': '1.0.0' };
  metadata.miniHarness.profile.bundles = ['profile-bundle'];
  writeJson(manifest, metadata);
  writeText(
    join(bundle, 'provider.mjs'),
    `import { Context } from 'mini-harness/cordis';
export default {
  provide: 'profileValue',
  apply(ctx, config) {
    if (!(ctx instanceof Context)) throw new Error('Duplicated Cordis runtime');
    ctx.provide('profileValue', config.value);
  },
};`,
  );
  writeText(
    join(bundle, 'disabled.mjs'),
    "throw new Error('A disabled entry was imported');",
  );
  writeJson(join(directory, 'node_modules', 'profile-consumer', 'package.json'), {
    name: 'profile-consumer',
    type: 'module',
    exports: { import: './entry.js' },
  });
  writeText(
    join(directory, 'node_modules', 'profile-consumer', 'entry.js'),
    `export const inject = ['profileValue'];
export const provide = 'profileResult';
export function apply(ctx, config) {
  ctx.provide('profileResult', ctx.profileValue + config.suffix);
}`,
  );
  writeText(
    fragment,
    `plugins:
  - id: consumer
    name: profile-consumer
    config:
      suffix: '!'
  - id: provider
    name: ./provider.mjs
    config:
      value: base
  - id: disabled
    name: ./disabled.mjs
    disabled: true
`,
  );
  writeText(
    file,
    `plugins:
  - id: provider
    config:
      value: patched
  - id: waiting
    name: ./waiting.mjs
`,
  );
  writeText(
    join(paths.home, 'profiles', 'custom', 'waiting.mjs'),
    `export default {
  inject: ['missingProfileService'],
  apply() { throw new Error('Waiting entry must not activate'); },
};`,
  );
  const launch = { interactive: false, shutdown() {} };
  for (const name of ['custom']) {
    const app = await bootProfile(name, paths, launch);
    try {
      assert.equal(app.ctx.get('harnessPluginCatalog'), undefined);
      assert.equal(app.ctx.get('profileResult'), 'patched!');
      assert.equal(app.ctx.harnessProfile.entries.get('disabled'), undefined);
      assert.equal(app.ctx.harnessProfile.entries.get('waiting')?.active, false);
      assert.equal(allowsDetachment(name, paths), false);
    } finally {
      await app.close();
    }
    assert.equal(app.ctx.get('profileResult'), undefined);
  }
  const profile = await loadProfile('custom', paths, new Context());
  try {
    profile.commit({ ...profile.read(), readOnlyTools: { example: ['read'] } });
  } finally {
    await profile.close();
  }
  const persisted = readFileSync(file, 'utf8');
  assert.match(readFileSync(manifest, 'utf8'), /profile-bundle/);
  assert.match(persisted, /value: patched/);
  assert.ok(persisted.includes('name: ./waiting.mjs'));
  assert.equal(readFileSync(fragment, 'utf8').includes('value: base'), true);
  assert.equal(readFileSync(join(directory, 'cordis.yml'), 'utf8'), 'plugins: []\n');
  const standalone = join(directory, 'standalone.yml');
  writeText(standalone, 'include: [' + JSON.stringify(fragment) + ']\n');
  await assert.rejects(bootProfile(standalone, paths, launch), /Invalid Profile name/);
  writeText(standalone, 'plugins:\n  - id: provider\n    config:\n      value: temporary\n');
  const patched = await bootProfile('custom', paths, { ...launch, patches: [standalone] });
  try {
    assert.equal(patched.ctx.get('profileResult'), 'temporary!');
    const profile = patched.ctx.harnessProfile;
    profile.commit({ ...profile.read(), readOnlyTools: { example: ['read', 'search'] } });
    assert.doesNotMatch(readFileSync(file, 'utf8'), /temporary/);
  } finally {
    await patched.close();
  }
  const reopened = await bootProfile('custom', paths, launch);
  try {
    assert.equal(reopened.ctx.get('profileResult'), 'patched!');
  } finally {
    await reopened.close();
  }

  writeText(fragment, 'include: [' + JSON.stringify(fragment) + ']\n');
  await assert.rejects(bootProfile('custom', paths, launch), /Cyclic Profile include/);
});

test('launcher inspects and recreates named Profile packages without mounting', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-cli-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, MINI_HARNESS_HOME: join(root, 'home') };
  const cli = (...args: string[]) =>
    execFileSync(process.execPath, ['dist/bin/mini-harness.js', ...args], { env, encoding: 'utf8' });
  const extra = join(root, 'extra.yml');
  writeText(extra, 'plugins:\n  - id: git-diff\n    disabled: true\n');
  const config = cli('rescue', '--from-default-profile', 'web', '--patch', extra, '--dump-config');
  const gitDiff = (yaml: string) =>
    parse(yaml).plugins.find(({ id }: { id: string }) => id === 'git-diff');
  assert.equal(gitDiff(config).disabled, true);
  assert.notEqual(gitDiff(cli('--dump-default-config')).disabled, true);
  assert.equal(JSON.parse(cli('--dump-config-schema')).properties.plugins.type, 'array');
  const patch = join(env.MINI_HARNESS_HOME, 'profiles', 'rescue', 'cordis.patch.yml');
  writeText(patch, 'not: a valid layer');
  assert.doesNotThrow(() => cli('rescue', '--dump-default-config'));
  assert.throws(() => cli('rescue', '--dump-config'), /Expected a Profile object/);
  writeText(patch, 'plugins: []\n');
  assert.doesNotMatch(readFileSync(join(env.MINI_HARNESS_HOME, 'profiles', 'rescue', 'cordis.patch.yml'), 'utf8'), /git-diff/);
  assert.throws(() => cli('--profile', extra, '--dump-config'), /Invalid Profile name/);
});
