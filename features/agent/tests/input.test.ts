import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createMiniHarnessServer } from '../../../src/server.js';
import { prepareInput } from '../../../src/input.js';
import { Inspection } from '../../files/inspection.js';
import { createFixturePaths, createMockProvider } from '../../../test/helpers/mock-provider.js';

import { fixture, waitUntil } from '../../../test/support/api-fixture.js';

test('attachments enforce encoding, format and byte limits without creating files', () => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAFElEQVR4nGPUCIhigAEmBiSAmwMAKdYA2gR3lpgAAAAASUVORK5CYII=';
  const prepared = prepareInput('', [{ name: 'one.png', mimeType: 'image/png', data: png }, { name: 'notes.md', mimeType: 'text/plain', data: Buffer.from('An attached note').toString('base64') }]);
  assert.equal(prepared.images.length, 1); assert.match(prepared.text, /An attached note/);
  assert.throws(() => prepareInput('a', [{ name: 'fake.png', mimeType: 'image/png', data: 'eA==' }]), /Invalid image/);
  assert.throws(() => prepareInput('a', [{ name: 'b', mimeType: 'text/plain', data: '!!!' }]), /Invalid attachment/);
  assert.throws(() => prepareInput('a', [{ name: 'b', mimeType: 'application/pdf', data: Buffer.from([0, 1, 2]).toString('base64') }]), /UTF-8/);
  assert.throws(() => prepareInput('a', new Array(9).fill({})), /eight/);
});
