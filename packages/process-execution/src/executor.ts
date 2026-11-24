import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import type { IsolatedProcess, SandboxPort } from '@mini-harness/sandbox/api';
import type { ProcessRequest, ProcessResult } from '@mini-harness/execution/request';

async function hostCommand(command: string, cwd: string, attachments?: string): Promise<IsolatedProcess> {
  const root = await realpath(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (attachments) env.MINI_HARNESS_ATTACHMENTS = attachments;
  else delete env.MINI_HARNESS_ATTACHMENTS;
  return process.platform === 'win32'
    ? { file: env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', '"' + command + '"'], cwd: root, env }
    : { file: '/bin/sh', args: ['-c', command], cwd: root, env };
}

export async function executeProcess(request: ProcessRequest, sandbox: SandboxPort, attachments?: string) {
  const { command, cwd, mode, timeoutSeconds, signal } = request;
  signal?.throwIfAborted();
  if (typeof command !== 'string' || !command.trim() || command.length > 16000) throw new Error('Invalid command');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) throw new Error('Invalid shell timeout');
  if (mode !== 'host' && mode !== 'isolated') throw new Error('Unknown sandbox mode');
  const { file, args, cwd: root, env } = mode === 'isolated' ? await sandbox.prepare(request, attachments) : await hostCommand(command, cwd, attachments);
  signal?.throwIfAborted();
  const windows = process.platform === 'win32';

  return await new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root, env,
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, windowsVerbatimArguments: windows,
      detached: !windows
    });
    const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const limit = 1024 * 1024;
    let bytes = 0;
    let reason: 'timeout' | 'cancelled' | 'output-limit' | undefined;
    let termination: Promise<void> | undefined;
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    if (!windows) child.once('exit', killGroup);
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
