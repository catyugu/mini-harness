import { spawn, spawnSync } from 'node:child_process';

export function supportsIsolation(platform: NodeJS.Platform = process.platform, probe: typeof spawnSync = spawnSync) {
  if (platform !== 'linux') return false;
  try { return probe('bwrap', ['--version'], { stdio: 'ignore', timeout: 1500 }).status === 0; }
  catch { return false; }
}

export function sandboxCommand(command: string, cwd: string, mode: 'isolated'|'host', platform: NodeJS.Platform = process.platform) {
  if (typeof command !== 'string' || !command.trim() || command.length > 16000) throw new Error('Invalid command');
  if (mode === 'isolated') {
    if (platform !== 'linux') throw new Error('Isolated shell requires Linux and bubblewrap; host execution needs explicit opt-in');
    // Empty mount namespace: no home, config, credentials, or network access.
    const args = ['--die-with-parent', '--unshare-all', '--clearenv',
      '--ro-bind-try', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin',
      '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64',
      '--ro-bind-try', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev',
      '--tmpfs', '/tmp', '--dir', '/workspace', '--bind', cwd, '/workspace',
      '--chdir', '/workspace', '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
      '--setenv', 'HOME', '/tmp', '--', '/bin/sh', '-lc', command];
    return { file: 'bwrap', args };
  }
  if (mode !== 'host') throw new Error('Unknown sandbox mode');
  return platform === 'win32'
    ? { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { file: '/bin/sh', args: ['-lc', command] };
}

export async function runShell(command: string, cwd: string, { mode = 'isolated', timeoutSeconds = 60, signal }: {mode?:'isolated'|'host'; timeoutSeconds?:number; signal?:AbortSignal} = {}) {
  if (mode === 'isolated' && !supportsIsolation()) throw new Error('Isolation unavailable: install bubblewrap on Linux or opt into trusted host execution');
  const { file, args } = sandboxCommand(command, cwd, mode);
  return await new Promise((resolve, reject) => {
    let stdout = '', stderr = '', finished = false, capped = false;
    const child = spawn(file, args, {
      cwd, env: mode === 'host' ? process.env : { PATH: '/usr/local/bin:/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    const terminate = () => child.kill('SIGKILL');
    const timer = setTimeout(terminate, timeoutSeconds * 1000);
    const abort = () => terminate();
    signal?.addEventListener('abort', abort, { once: true });
    const append = (key: 'out'|'err', chunk: Buffer) => {
      const value = chunk.toString('utf8');
      if (key === 'out') stdout += value;
      else stderr += value;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { capped = true; terminate(); }
    };
    child.stdout.on('data', (chunk) => append('out', chunk));
    child.stderr.on('data', (chunk) => append('err', chunk));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code, terminatedBy) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, signal: terminatedBy, stdout: stdout.slice(0, 1024 * 1024),
        stderr: stderr.slice(0, 1024 * 1024), truncated: capped });
    });
  });
}
