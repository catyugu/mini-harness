import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import type { ProcessCommand, ProcessExecutionPort } from '@mini-harness/process-execution/api';

export async function runShellCommand(
  execution: ProcessExecutionPort,
  command: ProcessCommand,
  timeoutSeconds: number,
  signal?: AbortSignal,
  write?: (text: string, channel: 'stdout' | 'stderr') => void,
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
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const channels = [
    { name: 'stdout' as const, stream: child.stdout, output: stdout, decoder: new StringDecoder('utf8') },
    { name: 'stderr' as const, stream: child.stderr, output: stderr, decoder: new StringDecoder('utf8') },
  ];
  child.stdin.end();
  for (const { name, stream, output, decoder } of channels) {
    stream.on('data', (value: Buffer | string) => {
      const chunk = typeof value === 'string' ? Buffer.from(value) : value;
      const allowed = Math.min(limit - bytes, chunk.length);
      if (allowed > 0) {
        const accepted = chunk.subarray(0, allowed);
        output.push(accepted);
        write?.(decoder.write(accepted), name);
      }
      bytes += allowed;
      if (allowed < chunk.length) terminate('output-limit');
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
      truncated: reason === 'output-limit',
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
