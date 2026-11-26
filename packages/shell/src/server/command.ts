import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ProcessCommand, ProcessExecutionPort } from '@mini-harness/process-execution/api';

export async function runShellCommand(
  execution: ProcessExecutionPort,
  command: ProcessCommand,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal,
  write?: (text: string, channel: 'stdout' | 'stderr') => void,
) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  let reason: 'timeout' | 'cancelled' | undefined;
  function terminate(cause: NonNullable<typeof reason>) {
    reason ??= cause;
    controller.abort();
  }
  const child = execution.start(command, controller.signal);
  const timeout = setTimeout(() => terminate('timeout'), timeoutMs);
  const cancel = () => terminate('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();

  let truncated = false;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const channels = [
    { name: 'stdout' as const, stream: child.stdout, output: stdout, decoder: new StringDecoder('utf8') },
    { name: 'stderr' as const, stream: child.stderr, output: stderr, decoder: new StringDecoder('utf8') },
  ];
  child.stdin.end();
  for (const { name, stream, output, decoder } of channels) {
    let bytes = 0;
    stream.on('data', (value: Buffer | string) => {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      const allowed = Math.min(maxOutputBytes - bytes, chunk.length);
      if (allowed > 0) {
        const accepted = chunk.subarray(0, allowed);
        output.push(accepted);
      }
      bytes += allowed;
      if (allowed < chunk.length) truncated = true;
      write?.(decoder.write(chunk), name);
    });
    stream.once('end', () => write?.(decoder.end(), name));
  }
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
      truncated,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
