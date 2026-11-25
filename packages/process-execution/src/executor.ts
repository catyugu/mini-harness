import { spawn } from 'node:child_process';
import type { ProcessRequest, ProcessResult } from './api.ts';

export async function executeProcess(request: ProcessRequest) {
  const { file, args = [], cwd, env, timeoutSeconds, signal, windowsVerbatimArguments } = request;
  signal?.throwIfAborted();
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds * 1000 > 2_147_483_647)
    throw new Error('Invalid process timeout');
  const windows = process.platform === 'win32';

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments,
      detached: !windows,
    });
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const limit = 1024 * 1024;
    let bytes = 0;
    let reason: 'timeout' | 'cancelled' | 'output-limit' | undefined;
    let termination: Promise<void> | undefined;
    const killGroup = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
      }
    };
    if (!windows) child.once('exit', killGroup);
    const terminate = (cause: typeof reason) => {
      if (reason) return;
      reason = cause;
      if (!child.pid) return;
      if (windows) {
        termination = new Promise<void>((done) => {
          const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
          const finish = () => {
            if (child.exitCode === null) child.kill();
            done();
          };
          killer.once('error', finish);
          killer.once('exit', finish);
        });
      } else killGroup();
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
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', async (code, terminatedBy) => {
      cleanup();
      await termination;
      resolve({
        code,
        signal: terminatedBy,
        reason,
        stdout: Buffer.concat(streams.stdout).toString('utf8'),
        stderr: Buffer.concat(streams.stderr).toString('utf8'),
        truncated: reason === 'output-limit',
      });
    });
  });
}
