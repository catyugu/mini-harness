import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsPath } from '@mini-harness/platform/paths';
import { rootedFileAccess } from '../src/api.ts';

test('failed or superseded atomic writes preserve the existing file and remove the temporary file', async (t) => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mini-harness-atomic-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state');
  mkdirSync(state);
  const file = join(root, 'edit.txt');
  writeFileSync(file, 'original');
  const workspace = rootedFileAccess(fs, root, { exclude: (path) => containsPath(state, path) });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(workspace.writeFile('edit.txt', 'replacement', false, cancelled.signal), {
    name: 'AbortError',
  });
  assert.equal((await workspace.readFile('edit.txt')).toString(), 'original');
  const probe = await fs.open(file);
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
  const view = rootedFileAccess(fs, root);
  const content = Buffer.alloc(16 * 1024 * 1024 + 8, 0xff);
  await view.writeFile('data.bin', content);
  assert.deepEqual(await view.readFile('data.bin'), content);
  const chunks: Uint8Array[] = [];
  for await (const chunk of view.chunks('data.bin')) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), content);
});
