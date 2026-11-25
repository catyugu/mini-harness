import { containsPath } from '@mini-harness/platform/paths';
import { expectPresent } from '../../../test/support/required.ts';
import test from 'node:test';
import { fileTools } from '../src/server/tools.ts';
import assert from 'node:assert/strict';

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RootedFiles } from '@mini-harness/file-access/root';

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
  const workspace = new RootedFiles(cwd, (path) => containsPath(state, path));
  const execute = (name: string, value: object) =>
    expectPresent(
      fileTools(cwd, () => workspace).find((tool) => tool.name === name),
      'file tool ' + name,
    ).execute('test', value as never, undefined, undefined, undefined);
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
  assert.deepEqual(found.content, [{ type: 'text', text: join(cwd, 'src', 'note.txt') }]);
  assert.deepEqual((await execute('find', { path: '.', pattern: 'src/**/*.txt' })).content, found.content);
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(workspace.writeFile('src/note.txt', 'replacement', false, cancel.signal), {
    name: 'AbortError',
  });
  assert.equal((await workspace.readFile('src/note.txt')).toString(), 'marked text');
  assert.doesNotMatch(
    JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text' })),
    /hidden\.txt/,
  );
  assert.doesNotMatch(JSON.stringify(await execute('ls', { path: '.' })), /linked|state/);
  await assert.rejects(execute('read', { path: '../private/secret.txt' }), /permitted root/);
  await assert.rejects(execute('read', { path: 'state/secret.txt' }), /permitted root/);
  const project = new RootedFiles(root, (path) => containsPath(state, path));
  assert.ok((await project.entries('project')).every(({ name }) => name !== 'state'));
  await assert.rejects(execute('write', { path: 'linked/secret.txt', content: 'changed' }));
  await assert.rejects(execute('grep', { path: 'linked/secret.txt', pattern: 'secret' }));
  await assert.rejects(execute('find', { path: privateDir, pattern: '*.txt' }));
});

test('failed or superseded atomic writes preserve the existing file and remove the temporary file', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mini-harness-atomic-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  mkdirSync(state);
  const file = join(root, 'edit.txt');
  writeFileSync(file, 'original');
  const workspace = new RootedFiles(root, (path) => containsPath(state, path));
  const probe = await open(file);
  const handles: { writeFile: typeof probe.writeFile } = Object.getPrototypeOf(probe);
  await probe.close();
  const realWrite = handles.writeFile;
  const partial = t.mock.method(handles, 'writeFile', async function (this: typeof probe) {
    await realWrite.call(this, 'partial write');
    throw new Error('Simulated write failure');
  });
  await assert.rejects(workspace.writeFile('edit.txt', 'replacement'), /Simulated write failure/);
  partial.mock.restore();
  assert.equal((await workspace.readFile('edit.txt')).toString(), 'original');
  const replacement = t.mock.method(handles, 'writeFile', async function (this: typeof probe) {
    await realWrite.call(this, 'finished temp file');
    rmSync(file);
    writeFileSync(file, 'new target');
  });
  await assert.rejects(workspace.writeFile('edit.txt', 'replacement'), /changed during write/);
  replacement.mock.restore();
  assert.equal((await workspace.readFile('edit.txt')).toString(), 'new target');
  assert.deepEqual(
    (await workspace.entries()).map(({ name }) => name),
    ['edit.txt'],
  );
});

test('confined file views write binary data and stream past workspace preview limits', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mini-harness-binary-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const view = new RootedFiles(root);
  const content = Buffer.alloc(16 * 1024 * 1024 + 8, 0xff);
  await view.writeFile('data.bin', content);
  assert.deepEqual(await view.readFile('data.bin'), content);
  const chunks: Uint8Array[] = [];
  for await (const chunk of view.chunks('data.bin')) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
});
