import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserBootstrap } from '@mini-harness/ui-runtime/bootstrap';
import { profileDescriptors, readProfile } from '@mini-harness/host/profile';
import { browserPage, verifyBrowserGraph } from '../support/browser-page.ts';
import { fixture } from '../support/api-fixture.ts';

test('the composed browser graph serves its runtime dependencies and excludes server code', async (t) => {
  const { base, request } = await fixture(t);
  const { body: snapshot }: { body: BrowserBootstrap } = await request('/bootstrap');
  const mounted = new Map(snapshot.ui.map((entry) => [entry.id, entry]));
  assert.equal(mounted.size, snapshot.ui.length);
  const plugins = await profileDescriptors(readProfile('web'));
  for (const { id, browser, defaultEnabled } of plugins)
    if (browser && defaultEnabled) assert.equal(mounted.get(id)?.browser, browser);

  for (const asset of [
    '/packages/host/src/application.js',
    '/packages/platform/src/local-secret.js',
    '/packages/input/src/prepare.js',
    '/packages/settings/src/server/manager.js',
    '/packages/transport/src/router.js',
    '/packages/shell/src/server/setup.js',
    '/packages/subagents/src/server/delegation.js',
    '/packages/sessions/tests/log.test.js',
  ])
    assert.equal((await fetch(base + asset)).status, 404, asset);

  const { boot, imports } = browserPage(await (await fetch(base)).text());
  assert.ok(imports['mini-harness/ui-runtime/plugin-settings']);
  await verifyBrowserGraph(base, [
    boot,
    ...Object.values(imports),
    ...plugins.flatMap(({ browser }) => (browser ? [browser] : [])),
  ]);

  assert.equal(
    (
      await request('/settings', 'PATCH', {
        entries: { files: { disabled: true }, shell: { disabled: false } },
      })
    ).status,
    200,
  );
  const { body: changed }: { body: BrowserBootstrap } = await request('/bootstrap');
  assert.equal(
    changed.ui.some(({ id }) => id === 'files'),
    false,
  );
  const shell = changed.ui.find(({ id }) => id === 'shell');
  assert.ok(shell);
  assert.match(await (await fetch(base + shell.browser)).text(), /inject: \['miniMessages'\]/);
  const conversation = changed.ui.find(({ id }) => id === 'core:conversation');
  assert.ok(conversation);
  assert.match(await (await fetch(base + conversation.browser)).text(), /inject: \[[^\]]*'miniApprovals'/);
  const conversationStyle = conversation?.styles?.[0];
  assert.ok(conversationStyle);
  const sheet = await fetch(base + conversationStyle);
  assert.equal(sheet.status, 200);
  assert.match(sheet.headers.get('content-type') ?? '', /^text\/css/);
  assert.match(await sheet.text(), /\.approval-heading/);
  assert.equal((await request('/settings', 'PATCH', { entries: { shell: { disabled: true } } })).status, 200);
  assert.equal((await fetch(base + conversationStyle)).status, 200);
});
