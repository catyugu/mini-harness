import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { ProcessCommand, ProcessExecutionPort } from '@mini-harness/process-execution/api';

async function capture(
  stream: Readable,
  limit: number,
  spill: () => Promise<string>,
  write?: (text: string) => void,
) {
  const output: Buffer[] = [];
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  let overflow: string | undefined;
  let file: FileHandle | undefined;
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const accepted = Math.min(limit - bytes, chunk.length);
      if (accepted) {
        output.push(chunk.subarray(0, accepted));
        bytes += accepted;
      }
      if (accepted < chunk.length) {
        if (!file) {
          overflow = await spill();
          file = await open(overflow, 'wx', 0o600);
        }
        await file.writeFile(chunk.subarray(accepted));
      }
      const text = decoder.write(chunk);
      if (text) write?.(text);
    }
    const tail = decoder.end();
    if (tail) write?.(tail);
    return { text: Buffer.concat(output).toString('utf8'), overflow };
  } finally {
    await file?.close();
  }
}

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

  let temporary: Promise<string> | undefined;
  const spill = async (channel: string) => join(
    await (temporary ??= mkdtemp(join(tmpdir(), 'mini-harness-output-'))),
    channel + '.log',
  );
  child.stdin.end();
  const collect = (channel: 'stdout' | 'stderr') =>
    capture(child[channel], maxOutputBytes, () => spill(channel), (text) => write?.(text, channel));
  const pending = [child.finished, collect('stdout'), collect('stderr')] as const;
  try {
    const [status, stdout, stderr] = await Promise.all(pending);
    return {
      ...status,
      reason,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutOverflow: stdout.overflow,
      stderrOverflow: stderr.overflow,
      truncated: Boolean(stdout.overflow || stderr.overflow),
    };
  } catch (error) {
    controller.abort();
    await Promise.allSettled(pending);
    if (temporary) {
      const directory = await temporary.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
