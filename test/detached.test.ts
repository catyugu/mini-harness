import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
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

test('--detached starts an independent, accessible server', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'mini-harness-detached-'));
  const cwd = join(root, 'work');
  const home = join(root, 'home');
  mkdirSync(cwd);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const port = await unusedPort();
  const cli = resolve('dist/bin/mini-harness.js');
  const child = spawn(process.execPath, [cli, '--detached', '--cwd', cwd, '--port', String(port)], {
    env: { ...process.env, MINI_HARNESS_HOME: home },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let out = '', err = '';
  child.stdout.on('data', (data) => { out += data.toString(); });
  child.stderr.on('data', (data) => { err += data.toString(); });
  const exit = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
  assert.equal(exit, 0, out + err);
  const statePath = join(home, 'server.json');
  assert.ok(existsSync(statePath), 'No detached server metadata: ' + out + err);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.ok(Number.isInteger(state.pid) && state.pid > 0);
  try {
    const response = await fetch('http://127.0.0.1:' + port + '/api/bootstrap', {
      headers: { Authorization: 'Bearer ' + state.token }
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(Array.isArray(data.sessions));
  } finally {
    try { process.kill(state.pid, 'SIGTERM'); } catch { /* Process may already have exited. */ }
    for (let attempt = 0; attempt < 80 && existsSync(statePath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
});
