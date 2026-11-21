import { spawn, spawnSync } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { containsPath } from './workspace.js';

type ShellMode = 'isolated' | 'host';
interface ShellResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  reason?: 'timeout' | 'cancelled' | 'output-limit';
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function supportsIsolation(platform: NodeJS.Platform = process.platform, probe: typeof spawnSync = spawnSync) {
  if (platform !== 'linux') return false;
  try {
    return probe('bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', '/usr/bin/prlimit', '--', '/bin/true'], {
      stdio: 'ignore', timeout: 1500, env: { PATH: '/usr/bin:/bin' }
    }).status === 0;
  } catch { return false; }
}

export function sandboxCommand(command: string, cwd: string, mode: ShellMode, platform: NodeJS.Platform = process.platform, timeout = 60) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16000) throw new Error('Invalid command');
  if (mode === 'isolated') {
    if (platform !== 'linux') throw new Error('Isolated shell requires Linux and bubblewrap; host execution needs explicit opt-in');
    return { file: 'bwrap', args: [
      '--die-with-parent', '--unshare-all', '--cap-drop', 'ALL', '--clearenv',
      '--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc/ld.so.cache', '/etc/ld.so.cache',
      '--ro-bind-try', '/etc/alternatives', '/etc/alternatives',
      '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
      '--bind', cwd, '/workspace', '--chdir', '/workspace',
      '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
      '--', '/usr/bin/prlimit', '--nofile=1024', '--fsize=268435456', '--cpu=' + timeout,
      '--core=0', '--', '/bin/sh', '-c', command
    ] };
  }
  if (mode !== 'host') throw new Error('Unknown sandbox mode');
  return platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + command + '"'] }
    : { file: '/bin/sh', args: ['-c', command] };
}

export async function runShell(command: string, cwd: string, {
  mode = 'isolated', timeoutSeconds = 60, signal, stateDir
}: { mode?: ShellMode; timeoutSeconds?: number; signal?: AbortSignal; stateDir?: string } = {}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error('Invalid shell timeout');
  const root = await realpath(cwd);
  if (mode === 'isolated') {
    if (stateDir) {
      const state = await realpath(stateDir);
      if (containsPath(root, state) || containsPath(state, root)) throw new Error('Use a workspace separate from mini-harness storage for isolated shell');
    }
    if (!supportsIsolation()) throw new Error('Isolation unavailable: Linux bubblewrap namespaces and prlimit are required');
  }
  signal?.throwIfAborted();
  const { file, args } = sandboxCommand(command, root, mode, process.platform, timeoutSeconds);
  const windows = process.platform === 'win32';

  return await new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root, env: mode === 'host' ? process.env : { PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: windows,
      detached: !windows
    });
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const limit = 1024 * 1024;
    let bytes = 0;
    let reason: 'timeout' | 'cancelled' | 'output-limit' | undefined;
    let termination: Promise<void> | undefined;
    const terminate = (cause: typeof reason) => {
      if (reason) return;
      reason = cause;
      if (!child.pid) return;
      if (windows) {
        termination = new Promise<void>((done) => {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          const finish = () => { if (child.exitCode === null) child.kill(); done(); };
          killer.once('error', finish);
          killer.once('exit', finish);
        });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    };
    const abort = () => terminate('cancelled');
    const timer = setTimeout(() => terminate('timeout'), timeoutSeconds * 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();

    const collect = (stream: keyof typeof streams, chunk: Buffer) => {
      const allowed = Math.min(limit - bytes, chunk.length);
      if (allowed > 0) streams[stream].push(chunk.subarray(0, allowed));
      bytes += allowed;
      if (allowed < chunk.length) terminate('output-limit');
    };
    child.stdout.on('data', (chunk) => collect('stdout', chunk));
    child.stderr.on('data', (chunk) => collect('stderr', chunk));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('close', async (code, terminatedBy) => {
      cleanup();
      await termination;
      resolve({ code, signal: terminatedBy, reason, stdout: Buffer.concat(streams.stdout).toString('utf8'),
        stderr: Buffer.concat(streams.stderr).toString('utf8'), truncated: reason === 'output-limit' });
    });
  });
}
