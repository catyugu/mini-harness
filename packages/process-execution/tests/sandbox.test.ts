import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProcessCommand } from '../src/api.ts';
import type { SandboxOptions } from '@mini-harness/sandbox/api';
import { startProcess } from '../src/executor.ts';
import { runShellCommand } from '../../shell/src/server/command.ts';
import { text } from 'node:stream/consumers';
import { LinuxSandbox } from '@mini-harness/sandbox/linux';
import { supportsIsolation } from '@mini-harness/platform/isolation';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sandbox = new LinuxSandbox();
const node = (code: string): ProcessCommand => ({
  file: process.execPath,
  args: ['-e', code],
  cwd: process.cwd(),
});
const execution = { start: startProcess };
const run = (code: string, timeoutSeconds = 60, signal?: AbortSignal) =>
  runShellCommand(execution, node(code), timeoutSeconds, signal);
const isolated = async (args: string[], mounts: SandboxOptions['mounts'] = [], env: NodeJS.ProcessEnv = {}) =>
  runShellCommand(
    execution,
    await sandbox.prepare(
      { file: '/bin/sh', args, cwd: process.cwd(), env: { HOME: '/tmp', PATH: '/usr/bin:/bin', ...env } },
      {
        workingDirectory: '/workspace',
        limits: { cpuSeconds: 10 },
        mounts: [{ source: process.cwd(), target: '/workspace' }, ...mounts],
      },
    ),
    10,
  );

test('a subprocess supports concurrent stdin, stdout and stderr streams', async () => {
  const child = startProcess(node('process.stdin.pipe(process.stdout); process.stderr.write("diagnostic")'));
  child.stdin.write('part one');
  child.stdin.end(' and part two');
  const [stdout, stderr, exit] = await Promise.all([text(child.stdout), text(child.stderr), child.finished]);
  assert.equal(stdout, 'part one and part two');
  assert.equal(stderr, 'diagnostic');
  assert.deepEqual(exit, { code: 0, signal: null });
});

test('isolation refuses unsupported hosts without falling back to host execution', async () => {
  assert.equal(supportsIsolation('win32'), false);
  assert.equal(supportsIsolation('darwin'), false);
  await assert.rejects(
    new LinuxSandbox('win32').prepare(node(''), { workingDirectory: '/' }),
    /requires Linux/,
  );
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
    const shell = await isolated(['-c', 'printf "%s|%s" "$PWD" "$HOME"']);
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
      [{ source: directory, target: '/data', readOnly: true }],
      { TEST_DATA: '/data' },
    );
    assert.equal(result.stdout, 'original');
    assert.notEqual(result.code, 0);
  },
);
