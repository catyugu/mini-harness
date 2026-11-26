import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessCommand } from '../src/api.ts';
import { startProcess } from '../src/executor.ts';
import { text } from 'node:stream/consumers';

const node = (code: string): ProcessCommand => ({
  file: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
});

test('a subprocess supports concurrent stdin, stdout and stderr streams', async () => {
  const child = startProcess(node('process.stdin.pipe(process.stdout); process.stderr.write("diagnostic")'));
  child.stdin.write('part one');
  child.stdin.end(' and part two');
  const [stdout, stderr, exit] = await Promise.all([text(child.stdout), text(child.stderr), child.finished]);
  assert.equal(stdout, 'part one and part two');
  assert.equal(stderr, 'diagnostic');
  assert.deepEqual(exit, { code: 0, signal: null });
});
