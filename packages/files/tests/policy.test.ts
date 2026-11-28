import { explicitFileReader, rootedFileAccess } from '@mini-harness/file-access/api';
import { containsPath } from '@mini-harness/platform/paths';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import { fileTools } from '../src/server/tools.ts';
import assert from 'node:assert/strict';

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture } from '../../../test/support/api-fixture.ts';

test('explicit reads use native paths while searches and writes use the workspace view', async (t) => {
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
  const access = app.runtime.plugins.ctx.harnessFileAccess;
  const workspace = rootedFileAccess(access, cwd, {
    exclude: (path) => containsPath(state, path),
  });
  const definitions = fileTools(
    cwd,
    () => workspace,
    () => explicitFileReader(access, cwd),
  );
  const execute = async (name: string, value: object) =>
    expectPresent(
      definitions.find((tool) => tool.name === name),
      'file tool ' + name,
    ).execute(value as Record<string, unknown>, {
      callId: 'test',
      signal: new AbortController().signal,
      update() {},
      write() {},
    });
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
  assert.match(JSON.stringify(await execute('read', { path: 'linked/secret.txt' })), /secret text/);
  symlinkSync(join(cwd, 'src'), join(cwd, 'alias'), 'junction');
  assert.match(JSON.stringify(await execute('read', { path: 'alias/note.txt' })), /marked text/);
  assert.deepEqual((await execute('find', { path: '.', pattern: 'src/**/*.txt' })).content, found.content);
  assert.doesNotMatch(
    JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text' })),
    /hidden\.txt/,
  );
  assert.deepEqual((await execute('ls', { path: privateDir })).content, [
    { type: 'text', text: 'secret.txt' },
  ]);
  for (const path of ['../private/secret.txt', 'state/secret.txt']) {
    assert.match(JSON.stringify(await execute('read', { path })), /secret text/);
    await assert.rejects(execute('write', { path, content: 'changed' }), /permitted root/);
  }
  await assert.rejects(execute('write', { path: 'linked/secret.txt', content: 'changed' }));
  await assert.rejects(execute('grep', { path: 'linked/secret.txt', pattern: 'secret' }));
  await assert.rejects(execute('find', { path: privateDir, pattern: '*.txt' }));
});
