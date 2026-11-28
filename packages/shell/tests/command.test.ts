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

test('each stream preserves Unicode across chunks and spills complete characters independently', async (t) => {
  const execution = await processExecution(t);
  const code =
    'const bytes = Buffer.from("a中😀日本語"); process.stdout.write(bytes.subarray(0, 2)); ' +
    'setTimeout(() => { process.stdout.write(bytes.subarray(2)); process.stderr.write("한글abc"); }, 30);';
  const live = { stdout: '', stderr: '' };
  const result = await runShellCommand(execution, node(code), 10000, 6, undefined, (text, channel) => {
    live[channel] += text;
  });
  assert.equal(result.code, 0);
  assert.equal(result.truncated, true);
  assert.equal(result.stdout, 'a中');
  assert.equal(result.stderr, '한글');
  assert.ok(result.stdoutOverflow && result.stderrOverflow);
  const directory = dirname(result.stdoutOverflow);
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(await readFile(result.stdoutOverflow, 'utf8'), '😀日本語');
  assert.equal(await readFile(result.stderrOverflow, 'utf8'), 'abc');
  assert.deepEqual(live, { stdout: 'a中😀日本語', stderr: '한글abc' });
  const small = await runShellCommand(execution, node('console.log("中文😀")'), 10000, 64);
  assert.equal(small.stdout, '中文😀\n');
  assert.equal(small.truncated, false);
  assert.equal(small.stdoutOverflow, undefined);
  assert.equal(small.stderrOverflow, undefined);
});
