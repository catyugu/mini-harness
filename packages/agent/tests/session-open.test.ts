import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createMiniHarnessServer } from '../../../src/server.js';
import { createMockProvider, createFixturePaths } from '../../../test/helpers/mock-provider.js';

test('concurrent opening of one conversation shares a single Pi AgentSession', { timeout: 30000 }, async (t) => {
  const mock = await createMockProvider();
  t.after(() => mock.close());
  const { root, paths } = createFixturePaths(mock.url);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = await createMiniHarnessServer(paths);
  t.after(() => app.close());
  const item = app.runtime.registry.create();
  const [first, second, third] = await Promise.all([
    app.runtime.pi.open(item.id),
    app.runtime.pi.open(item.id),
    app.runtime.getConversation(item.id)
  ]);
  assert.strictEqual(first, second);
  assert.equal(third.id, item.id);
  assert.equal(app.runtime.pi.size, 1);
});

