import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxCommand } from '../sandbox.js';
import { supportsIsolation } from '../isolation.js';
import { runShell } from '../sandbox.js';

test('isolation refuses unsupported hosts', () => {
  assert.equal(supportsIsolation('win32'), false);
  assert.equal(supportsIsolation('darwin'), false);
  assert.throws(() => sandboxCommand('echo hi', '/tmp', 'isolated', 'win32'), /requires Linux/);
});

test('isolation never silently selects a host shell', () => {
  const command = sandboxCommand('pwd', '/tmp', 'isolated', 'linux');
  assert.equal(command.file, 'bwrap');
  assert.ok(command.args.includes('--unshare-all'));
  assert.ok(command.args.includes('--clearenv'));
  assert.ok(command.args.includes('--bind'));
  assert.equal(command.args[command.args.length - 1], 'pwd');
  assert.throws(() => sandboxCommand('', '/tmp', 'host'), /Invalid command/);
  assert.throws(() => sandboxCommand('ls', '/tmp', 'invented' as any), /Unknown/);
});


test('shell reports cancellation and timeouts and bounds output', { timeout: 15000 }, async () => {
  const windows = process.platform === 'win32';
  const long = windows ? 'ping -n 10 127.0.0.1' : 'sleep 10 & wait';
  const noisy = windows ? 'for /L %i in (1,1,25000) do @echo 01234567890123456789012345678901234567890123456789' : 'yes x';
  const controller = new AbortController();
  const cancelled = runShell(long, process.cwd(), { mode: 'host', signal: controller.signal });
  setTimeout(() => controller.abort(), 200);
  assert.equal((await cancelled).reason, 'cancelled');
  assert.equal((await runShell(long, process.cwd(), { mode: 'host', timeoutSeconds: 1 })).reason, 'timeout');
  const result = await runShell(noisy, process.cwd(), { mode: 'host', timeoutSeconds: 10 });
  assert.equal(result.reason, 'output-limit');
  assert.ok(Buffer.byteLength(result.stdout) <= 1024 * 1024);
});

test('isolated shell runs without provider process environment', { skip: process.env.MINI_HARNESS_REQUIRE_ISOLATION !== '1' && !supportsIsolation() }, async () => {
  const shell = await runShell('printf "%s|%s" "$PWD" "$HOME"', process.cwd());
  assert.equal(shell.code, 0);
  assert.equal(shell.stdout, '/workspace|/tmp');
});
