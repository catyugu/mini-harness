import test from 'node:test';
import assert from 'node:assert/strict';

import { prepareInput } from '../../../src/input.js';

test('attachments enforce encoding, format and byte limits without creating files', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  const prepared = prepareInput('', [{ name: 'one.png', mimeType: 'image/png', data: png }, { name: 'notes.md', mimeType: 'text/plain', data: Buffer.from('An attached note').toString('base64') }]);
  assert.equal(prepared.images.length, 1); assert.match(prepared.text, /An attached note/);
  assert.throws(() => prepareInput('a', [{ name: 'fake.png', mimeType: 'image/png', data: 'eA==' }]), /Invalid image/);
  assert.throws(() => prepareInput('a', [{ name: 'b', mimeType: 'text/plain', data: '!!!' }]), /Invalid attachment/);
  assert.throws(() => prepareInput('a', [{ name: 'b', mimeType: 'application/pdf', data: Buffer.from([0, 1, 2]).toString('base64') }]), /UTF-8/);
  assert.throws(() => prepareInput('a', new Array(9).fill({})), /eight/);
});
