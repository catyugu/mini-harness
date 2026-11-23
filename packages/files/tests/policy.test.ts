import test from 'node:test';
import { fileTools } from '../tools.js';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Workspace } from '../../file-access/workspace.js';

test('workspace tools share one policy for reads, searches and writes', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mini-harness-policy-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const privateDir = join(root, 'private');
  const state = join(cwd, 'state');
  for (const dir of [cwd, privateDir, state]) mkdirSync(dir);
  writeFileSync(join(privateDir, 'secret.txt'), 'secret text');
  writeFileSync(join(state, 'secret.txt'), 'secret text');
  symlinkSync(privateDir, join(cwd, 'linked'), 'junction');
  writeFileSync(join(cwd, '.gitignore'), 'hidden.txt\n');
  writeFileSync(join(cwd, 'hidden.txt'), 'marked text');
  const workspace = new Workspace(cwd, state);
  const execute = (name: string, value: object) => fileTools(cwd, workspace).find((tool) => tool.name === name)
    .execute('test', value as never, undefined, undefined, undefined);
  assert.match(JSON.stringify(await execute('write', { path: 'src/note.txt', content: 'good text' })), /wrote/i);
  await execute('edit', { path: 'src/note.txt', edits: [{ oldText: 'good', newText: 'marked' }] });
  assert.match(JSON.stringify(await execute('read', { path: 'src/note.txt' })), /marked text/);
  assert.match(JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text', glob: '*.txt' })), /src\/note.txt/);
  const found = JSON.stringify(await execute('find', { path: '.', pattern: '*.txt' }));
  assert.match(found, /src\/note.txt/);
  assert.doesNotMatch(found, /hidden\.txt/);
  assert.doesNotMatch(JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text' })), /hidden\.txt/);
  assert.doesNotMatch(JSON.stringify(await execute('ls', { path: '.' })), /linked|state/);
  await assert.rejects(execute('read', { path: '../private/secret.txt' }), /permitted workspace/);
  await assert.rejects(execute('read', { path: 'state/secret.txt' }), /permitted workspace/);
  await assert.rejects(execute('write', { path: 'linked/secret.txt', content: 'changed' }));
  await assert.rejects(execute('grep', { path: 'linked/secret.txt', pattern: 'secret' }));
  await assert.rejects(execute('find', { path: privateDir, pattern: '*.txt' }));
});
