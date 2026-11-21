import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxCommand, supportsIsolation } from '../src/sandbox.js';

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
  assert.throws(() => sandboxCommand('ls', '/tmp', 'invented'), /Unknown/);
});
