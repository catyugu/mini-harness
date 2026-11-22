import test from 'node:test';
import assert from 'node:assert/strict';
import { sandboxCommand } from '../features/shell/sandbox.js';
import { supportsIsolation } from '../src/platform/isolation.js';

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

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runShell } from '../features/shell/sandbox.js';
import { Workspace } from '../features/files/workspace.js';

test('workspace tools share one policy for reads, searches and writes', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  const privateDir = join(root, 'private');
  const state = join(cwd, 'state');
  for (const dir of [cwd, privateDir, state]) mkdirSync(dir);
  writeFileSync(join(privateDir, 'secret.txt'), 'secret text');
  writeFileSync(join(state, 'secret.txt'), 'secret text');
  symlinkSync(privateDir, join(cwd, 'linked'), 'junction');
  writeFileSync(join(cwd, '.gitignore'), 'hidden.txt\n');
  writeFileSync(join(cwd, 'hidden.txt'), 'marked text');
  const workspace = new Workspace(cwd, state);
  const execute = (name: string, value: object) => workspace.tools().find((tool) => tool.name === name)
    .execute('test', value as never, undefined, undefined, undefined);
  assert.match(JSON.stringify(await execute('write', { path: 'src/note.txt', content: 'good text' })), /wrote/i);
  await execute('edit', { path: 'src/note.txt', edits: [{ oldText: 'good', newText: 'marked' }] });
  assert.match(JSON.stringify(await execute('read', { path: 'src/note.txt' })), /marked text/);
  assert.match(JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text', glob: '*.txt' })), /src\/note.txt/);
  const found = JSON.stringify(await execute('find', { path: '.', pattern: '*.txt' }));
  assert.match(found, /src\/note.txt/);
  assert.doesNotMatch(found, /hidden\.txt/);
  assert.doesNotMatch(JSON.stringify(await execute('grep', { path: '.', pattern: 'marked text' })), /hidden\.txt/);
  assert.doesNotMatch(JSON.stringify(await execute('ls', { path: '.' })), /linked|state/);
  await assert.rejects(execute('read', { path: '../private/secret.txt' }), /permitted workspace/);
  await assert.rejects(execute('read', { path: 'state/secret.txt' }), /permitted workspace/);
  await assert.rejects(execute('write', { path: 'linked/secret.txt', content: 'changed' }));
  await assert.rejects(execute('grep', { path: 'linked/secret.txt', pattern: 'secret' }));
  await assert.rejects(execute('find', { path: privateDir, pattern: '*.txt' }));
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
