import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessCommand } from '../src/api.ts';
import { startProcess } from '../src/executor.ts';
import { runShellCommand } from '../../shell/src/server/command.ts';
import { text } from 'node:stream/consumers';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const node = (code: string): ProcessCommand => ({
  file: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
});
const execution = { start: startProcess };
const run = (code: string, timeoutMs = 60000, signal?: AbortSignal) =>
  runShellCommand(execution, node(code), timeoutMs, 64000, signal);
test('a subprocess supports concurrent stdin, stdout and stderr streams', async () => {
  const child = startProcess(node('process.stdin.pipe(process.stdout); process.stderr.write("diagnostic")'));
  child.stdin.write('part one');
  child.stdin.end(' and part two');
  const [stdout, stderr, exit] = await Promise.all([text(child.stdout), text(child.stderr), child.finished]);
  assert.equal(stdout, 'part one and part two');
  assert.equal(stderr, 'diagnostic');
  assert.deepEqual(exit, { code: 0, signal: null });
});

test('shell reports cancellation and timeouts', { timeout: 15000 }, async () => {
  const long = 'setTimeout(() => {}, 10000)';
  const controller = new AbortController();
  const cancelled = run(long, 60000, controller.signal);
  setTimeout(() => controller.abort(), 200);
  assert.equal((await cancelled).reason, 'cancelled');
  assert.equal((await run(long, 100)).reason, 'timeout');

});


test('each stream spills its remaining bytes independently without stopping the command', async (t) => {
  const code = 'process.stdout.write("a".repeat(128)); process.stderr.write("b".repeat(130));';
  const result = await runShellCommand(execution, node(code), 10000, 64);
  assert.equal(result.code, 0);
  assert.equal(result.reason, undefined);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, 'a'.repeat(64));
  assert.equal(result.stderr, 'b'.repeat(64));
  assert.ok(result.stdoutOverflow && result.stderrOverflow);
  const directory = dirname(result.stdoutOverflow);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readFile(result.stdoutOverflow, 'utf8'), 'a'.repeat(64));
  assert.equal(await readFile(result.stderrOverflow, 'utf8'), 'b'.repeat(66));
  const small = await runShellCommand(execution, node('console.log("ok")'), 10000, 64);
  assert.equal(small.truncated, false);
  assert.equal(small.stdoutOverflow, undefined);
  assert.equal(small.stderrOverflow, undefined);
});
