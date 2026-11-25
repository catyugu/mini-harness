import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const execute = promisify(execFile);

test('--detached starts an independent, accessible server', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-detached-'));
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await unusedPort();
  const cli = resolve('dist/bin/mini-harness.js');
  const env = { ...process.env, MINI_HARNESS_HOME: home };
  const options = { cwd, env, timeout: 15000 };
  const command = (...args: string[]) => execute(process.execPath, [cli, ...args], options);
  mkdirSync(home);
  const statePath = join(home, 'server.json');
  writeFileSync(statePath, 'stale');
  await assert.rejects(command('status'), (error: NodeJS.ErrnoException) => String(error.code) === '1');
  assert.equal(existsSync(statePath), false);
  const child = spawn(process.execPath, [cli, '--detached', '--port', String(port)], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let out = '',
    err = '';
  child.stdout.on('data', (data) => {
    out += data.toString();
  });
  child.stderr.on('data', (data) => {
    err += data.toString();
  });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  assert.equal(exit, 0, out + err);
  assert.ok(existsSync(statePath), 'No detached server metadata: ' + out + err);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(Number.isInteger(state.pid) && state.pid > 0);
  const token = /#token=([a-f0-9]{64})/.exec(out)?.[1];
  assert.ok(token);
  assert.equal(state.token, undefined);
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/bootstrap', {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.ui));
    assert.match((await command('status')).stdout, new RegExp(String(state.pid)));
    const otherPort = await unusedPort();
    await assert.rejects(command('--port', String(otherPort)), /already running/);
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).pid, state.pid);
    assert.equal((await fetch(state.url + '/api/shutdown', { method: 'POST' })).status, 401);
    assert.match((await command('stop')).stdout, /stopped/);
    assert.equal(existsSync(statePath), false);
    await assert.rejects(command('status'), /Command failed/);
  } finally {
    if (existsSync(statePath))
      await command('stop').catch(() => {
        try {
          process.kill(state.pid, 'SIGTERM');
        } catch {}
      });
  }
});

test('port collisions fail promptly and release the instance lock', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-port-test-'));
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  const address = listener.address();
  assert.ok(address && typeof address === 'object');
  const cli = resolve('dist/bin/mini-harness.js');
  const env = { ...process.env, MINI_HARNESS_HOME: join(root, 'home') };
  const options = { cwd: root, env, timeout: 6000 };
  const call = () => execute(process.execPath, [cli, '--port', String(address.port)], options);
  await assert.rejects(call(), /HTTP port is already in use/);
  await assert.rejects(call(), /HTTP port is already in use/);
  assert.equal(existsSync(join(root, 'home', 'server.json')), false);
});
