import { runTool } from '@mini-harness/tools/execution';
import { containsPath } from '@mini-harness/platform/paths';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import { fileTools } from '../src/server/tools.ts';
import assert from 'node:assert/strict';

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../../../test/support/api-fixture.ts';

test('workspace tools share one policy for reads, searches and writes', async (t) => {
  const { app, root: directory } = await fixture(t);
  const root = realpathSync.native(directory);
  const cwd = join(root, 'project');
  const privateDir = join(root, 'private');
  const state = join(cwd, 'state');
  for (const dir of [cwd, privateDir, state]) mkdirSync(dir);
  writeFileSync(join(privateDir, 'secret.txt'), 'secret text');
  writeFileSync(join(state, 'secret.txt'), 'secret text');
  symlinkSync(privateDir, join(cwd, 'linked'), 'junction');
  writeFileSync(join(cwd, '.gitignore'), 'hidden.txt\n');
  writeFileSync(join(cwd, 'hidden.txt'), 'marked text');
  const workspace = app.runtime.plugins.ctx.harnessFileAccess.open(cwd, { exclude: (path) => containsPath(state, path) });
  const execute = async (name: string, value: object) =>
    runTool(
      expectPresent(
        fileTools(cwd, () => workspace).find((tool) => tool.name === name),
        'file tool ' + name,
      ),
      'test',
      value as Record<string, unknown>,
    );
  assert.match(
    JSON.stringify(await execute('write', { path: 'src/note.txt', content: 'good text' })),
    /wrote/i,
  );
  await execute('edit', { path: 'src/note.txt', edits: [{ oldText: 'good', newText: 'marked' }] });
  assert.match(JSON.stringify(await execute('read', { path: 'src/note.txt' })), /marked text/);
  assert.match(
    JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text', glob: '*.txt' })),
    /src\/note.txt/,
  );
  const found = await execute('find', { path: '.', pattern: '*.txt' });
  assert.deepEqual(found.content, [{ type: 'text', text: 'src/note.txt' }]);
  assert.deepEqual((await execute('find', { pattern: 'src' })).content, [{ type: 'text', text: 'src/' }]);
  for (const path of ['.', 'src', 'src/']) {
    await assert.rejects(execute('read', { path }), { code: 'invalid_input', message: /Use ls/ });
  }
  await assert.rejects(execute('read', { path: 'missing.txt' }), { code: 'ENOENT' });
  await assert.rejects(execute('read', { path: 'src/note.txt/child' }), { code: 'invalid_input' });
  await assert.rejects(execute('read', { path: 'linked/secret.txt' }), { code: 'forbidden' });
  symlinkSync(join(cwd, 'src'), join(cwd, 'alias'), 'junction');
  assert.match(JSON.stringify(await execute('read', { path: 'alias/note.txt' })), /marked text/);
  assert.deepEqual((await execute('find', { path: '.', pattern: 'src/**/*.txt' })).content, found.content);
  assert.doesNotMatch(
    JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text' })),
    /hidden\.txt/,
  );
  assert.doesNotMatch(JSON.stringify(await execute('ls', { path: '.' })), /linked|state/);
  await assert.rejects(execute('read', { path: '../private/secret.txt' }), /permitted root/);
  await assert.rejects(execute('read', { path: 'state/secret.txt' }), /permitted root/);
  await assert.rejects(execute('write', { path: 'linked/secret.txt', content: 'changed' }));
  await assert.rejects(execute('grep', { path: 'linked/secret.txt', pattern: 'secret' }));
  await assert.rejects(execute('find', { path: privateDir, pattern: '*.txt' }));
});
