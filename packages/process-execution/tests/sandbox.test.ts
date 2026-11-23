import test from 'node:test';
import assert from 'node:assert/strict';
import { executeProcess } from '../executor.js';
import { LinuxSandbox } from '@mini-harness/sandbox/linux';
import { supportsIsolation } from '@mini-harness/sandbox/isolation';
import { tmpdir } from 'node:os';

const sandbox = new LinuxSandbox(tmpdir());
const run = (command: string, mode: 'host' | 'isolated', timeoutSeconds = 60, signal?: AbortSignal) =>
  executeProcess({ command, cwd: process.cwd(), mode, timeoutSeconds, signal }, sandbox);

test('isolation refuses unsupported hosts without falling back to host execution', async () => {
  assert.equal(supportsIsolation('win32'), false);
  assert.equal(supportsIsolation('darwin'), false);
  await assert.rejects(executeProcess({ command: 'echo must not run', cwd: process.cwd(), mode: 'isolated', timeoutSeconds: 1 },
    new LinuxSandbox(tmpdir(), 'win32')), /requires Linux/);
  await assert.rejects(run('', 'host'), /Invalid command/);
  await assert.rejects(run('echo must not run', 'invalid' as 'host'), /Unknown sandbox mode/);
});

test('shell reports cancellation and timeouts and bounds output', { timeout: 15000 }, async () => {
  const windows = process.platform === 'win32';
  const long = windows ? 'ping -n 10 127.0.0.1' : 'sleep 10 & wait';
  const noisy = windows ? 'for /L %i in (1,1,25000) do @echo 01234567890123456789012345678901234567890123456789' : 'yes x';
  const controller = new AbortController();
  const cancelled = run(long, 'host', 60, controller.signal);
  setTimeout(() => controller.abort(), 200);
  assert.equal((await cancelled).reason, 'cancelled');
  assert.equal((await run(long, 'host', 1)).reason, 'timeout');
  const result = await run(noisy, 'host', 10);
  assert.equal(result.reason, 'output-limit');
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test('isolated shell runs without provider process environment', { skip: process.env.MINI_HARNESS_REQUIRE_ISOLATION !== '1' && !supportsIsolation() }, async () => {
  const shell = await run('printf "%s|%s" "$PWD" "$HOME"', 'isolated');
  assert.equal(shell.code, 0);
  assert.equal(shell.stdout, '/workspace|/tmp');
});
