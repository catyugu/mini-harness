import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeText } from '@mini-harness/platform/json';
import { bootProfile } from '@mini-harness/host/application';
import { createFixturePaths, createMockProvider } from '../helpers/mock-provider.js';

test('YAML Profile composes through Cordis and persists Web entry changes', async (t) => {
  const mock = await createMockProvider();
  const { paths, root } = createFixturePaths(mock.url);
  t.after(async () => {
    await mock.close();
    rmSync(root, { recursive: true, force: true });
  });
  const configure = (name: string) => join(paths.home, 'profiles', name, 'cordis.yml');
  writeText(configure('web'), 'plugins:\n  - id: git-diff\n    disabled: true\n');
  const launch = { interactive: false, shutdown() {} };
  const web = await bootProfile('web', paths, launch);
  try {
    assert.equal(web.ctx.harnessProfile.entries.get('git-diff'), undefined);
    assert.ok(web.ctx.get('harnessWeb'));
    assert.ok(web.ctx.get('harnessGateway'));
    assert.ok(web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'files'));
    assert.ok(!web.ctx.harnessPluginCatalog.browser().some(({ id }) => id === 'git-diff'));
    assert.doesNotMatch(readFileSync(paths.settings, 'utf8'), /pluginConfig|providers|"plugins"/);
    await assert.rejects(
      web.ctx.harnessSettingsStore.update({ plugins: { 'core:layout': false } }),
      /Required Profile entry/,
    );
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
  await assert.rejects(bootProfile('web', paths, launch), /cordis\.yml.*tag/is);
});
