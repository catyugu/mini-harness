import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessCommand } from '@mini-harness/process-execution/api';
import { startTestProfile } from '../../../test/support/profile.ts';
import { createFixturePaths } from '../../../test/support/mock-provider.ts';
import { runShellCommand } from '../src/server/command.ts';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

const node = (code: string): ProcessCommand => ({
  file: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
});

async function processExecution(t: TestContext) {
  const { root, paths } = createFixturePaths('http://127.0.0.1:1/v1');
  const app = await startTestProfile(paths, 'process', [{ name: '@mini-harness/process-execution' }]);
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  return app.ctx.harnessProcess;
}

test('shell reports cancellation and timeouts', { timeout: 15000 }, async (t) => {
  const execution = await processExecution(t);
  const long = 'setTimeout(() => {}, 10000)';
  const controller = new AbortController();
  const cancelled = await runShellCommand(
    execution,
    node('console.log("ready"); ' + long),
    60000,
    64000,
    controller.signal,
    () => controller.abort(),
  );
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal((await runShellCommand(execution, node(long), 100, 64000)).reason, 'timeout');
});

test('each stream spills its remaining bytes independently without stopping the command', async (t) => {
  const execution = await processExecution(t);
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
