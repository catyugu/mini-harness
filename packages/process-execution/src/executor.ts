import { spawn } from 'node:child_process';
import type { ProcessCommand, ProcessExit, RunningProcess } from './api.ts';

export function startProcess(command: ProcessCommand, signal?: AbortSignal): RunningProcess {
  signal?.throwIfAborted();
  const { file, args = [], cwd, env, windowsVerbatimArguments } = command;
  const windows = process.platform === 'win32';
  const child = spawn(file, args, {
    cwd,
    env,
    stdio: 'pipe',
    windowsHide: true,
    windowsVerbatimArguments,
    detached: !windows,
  });

  function killGroup() {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
    }
  }

  let termination: Promise<void> | undefined;
  function abort() {
    if (!windows) return killGroup();
    if (!child.pid) return;
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
  }

  if (!windows) child.once('exit', killGroup);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const finished = new Promise<ProcessExit>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', async (code, signalCode) => {
      signal?.removeEventListener('abort', abort);
      await termination;
      resolve({ code, signal: signalCode });
    });
  });
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, finished };
}
