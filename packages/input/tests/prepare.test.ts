import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareInput } from '../src/prepare.ts';

test('attachments enforce encoding, format and byte limits without creating files', () => {
  const png =
    'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  const prepared = prepareInput('', [
    { name: 'one.png', mimeType: 'image/png', data: png },
    { name: 'notes.md', mimeType: 'text/plain', data: Buffer.from('An attached note').toString('base64') },
  ]);
  assert.equal(prepared.input.userText, '');
  assert.deepEqual(
    prepared.input.attachments.map(({ name, mimeType }) => ({ name, mimeType })),
    [
      { name: 'one.png', mimeType: 'image/png' },
      { name: 'notes.md', mimeType: 'text/plain' },
    ],
  );
  assert.deepEqual(
    prepared.files.map(({ id }) => id),
    prepared.input.attachments.map(({ id }) => id),
  );
  assert.equal(prepared.images.length, 1);
  assert.match(prepared.text, /An attached note/);
  assert.throws(
    () => prepareInput('a', [{ name: 'fake.png', mimeType: 'image/png', data: 'eA==' }]),
    /Invalid image/,
  );
  assert.throws(
    () => prepareInput('a', [{ name: 'b', mimeType: 'text/plain', data: '!!!' }]),
    /Invalid attachment/,
  );
  const binary = prepareInput('a', [
    { name: 'b.pdf', mimeType: 'application/pdf', data: Buffer.from([0, 1, 2]).toString('base64') },
  ]);
  assert.match(binary.text, /Uploaded file: "b.pdf"/);
  assert.deepEqual(binary.files[0].bytes, Buffer.from([0, 1, 2]));
  assert.throws(() => prepareInput('a', new Array(9).fill({})), /eight/);
});
