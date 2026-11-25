import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessCommand } from '../src/api.ts';
import type { SandboxOptions } from '@mini-harness/sandbox/api';
import { executeProcess } from '../src/executor.ts';
import { LinuxSandbox } from '@mini-harness/sandbox/linux';
import { supportsIsolation } from '@mini-harness/platform/isolation';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sandbox = new LinuxSandbox(tmpdir());
const node = (code: string): ProcessCommand => ({
  file: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
});
const run = (code: string, timeoutSeconds = 60, signal?: AbortSignal) =>
  executeProcess({ ...node(code), timeoutSeconds, signal });
const isolated = async (args: string[], options: SandboxOptions, env?: NodeJS.ProcessEnv) =>
  executeProcess({
    ...(await sandbox.prepare({ file: '/bin/sh', args, cwd: process.cwd(), env }, options)),
    timeoutSeconds: options.cpuSeconds,
  });

test('isolation refuses unsupported hosts without falling back to host execution', async () => {
  assert.equal(supportsIsolation('win32'), false);
  assert.equal(supportsIsolation('darwin'), false);
  await assert.rejects(
    new LinuxSandbox(tmpdir(), 'win32').prepare(node(''), { cpuSeconds: 1 }),
    /requires Linux/,
  );
  await assert.rejects(run('', 0), /Invalid process timeout/);
});

test('shell reports cancellation and timeouts and bounds output', { timeout: 15000 }, async () => {
  const long = 'setTimeout(() => {}, 10000)';
  const noisy = 'process.stdout.write("x".repeat(1024 * 1024 + 1))';
  const controller = new AbortController();
  const cancelled = run(long, 60, controller.signal);
  setTimeout(() => controller.abort(), 200);
  assert.equal((await cancelled).reason, 'cancelled');
  assert.equal((await run(long, 1)).reason, 'timeout');
  const result = await run(noisy, 10);
  assert.equal(result.reason, 'output-limit');
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test(
  'isolated shell runs without provider process environment',
  { skip: process.env.MINI_HARNESS_REQUIRE_ISOLATION !== '1' && !supportsIsolation() },
  async () => {
    const shell = await isolated(['-c', 'printf "%s|%s" "$PWD" "$HOME"'], { cpuSeconds: 10 });
    assert.equal(shell.code, 0);
    assert.equal(shell.stdout, '/workspace|/tmp');
  },
);

test(
  'explicit mounts are visible and read-only in isolated mode',
  { skip: process.env.MINI_HARNESS_REQUIRE_ISOLATION !== '1' && !supportsIsolation() },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'mini-harness-mount-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'input'), 'original');
    const result = await isolated(
      ['-c', 'cat "$TEST_DATA/input"; printf modified > "$TEST_DATA/input"'],
      { cpuSeconds: 10, mounts: [{ source: directory, target: '/data', readOnly: true }] },
      { TEST_DATA: '/data' },
    );
    assert.equal(result.stdout, 'original');
    assert.notEqual(result.code, 0);
  },
);
