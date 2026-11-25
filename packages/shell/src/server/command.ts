import { finished } from 'node:stream/promises';
import type { ProcessCommand, ProcessExecutionPort } from '@mini-harness/process-execution/api';

export async function runShellCommand(
  execution: ProcessExecutionPort,
  command: ProcessCommand,
  timeoutSeconds: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let reason: 'timeout' | 'cancelled' | 'output-limit' | undefined;
  function terminate(cause: NonNullable<typeof reason>) {
    reason ??= cause;
    controller.abort();
  }
  const child = execution.start(command, controller.signal);
  const timeout = setTimeout(() => terminate('timeout'), timeoutSeconds * 1000);
  const cancel = () => terminate('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();

  let bytes = 0;
  const limit = 1024 * 1024;
  function collect(output: Buffer[], chunk: Buffer) {
    const allowed = Math.min(limit - bytes, chunk.length);
    if (allowed > 0) output.push(chunk.subarray(0, allowed));
    bytes += allowed;
    if (allowed < chunk.length) terminate('output-limit');
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdin.end();
  child.stdout.on('data', (chunk: Buffer | string) =>
    collect(stdout, typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
  );
  child.stderr.on('data', (chunk: Buffer | string) =>
    collect(stderr, typeof chunk === 'string' ? Buffer.from(chunk) : chunk),
  );
  try {
    const [status] = await Promise.all([
      child.finished,
      finished(child.stdout, { cleanup: true }),
      finished(child.stderr, { cleanup: true }),
    ]);
    return {
      ...status,
      reason,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      truncated: reason === 'output-limit',
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
