import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { ProcessCommand, ProcessExecutionPort } from '@mini-harness/process-execution/api';

async function capture(
  stream: Readable,
  limit: number,
  spill: () => Promise<string>,
  write?: (text: string) => void,
) {
  let output = '';
  let bytes = 0;
  let overflow: string | undefined;
  let file: FileHandle | undefined;
  try {
    for await (const chunk of stream.setEncoding('utf8')) {
      let text = String(chunk);
      write?.(text);
      if (!file) {
        const size = Buffer.byteLength(text);
        if (size <= limit - bytes) {
          output += text;
          bytes += size;
          continue;
        }
        let end = 0;
        for (const character of text) {
          const length = Buffer.byteLength(character);
          if (bytes + length > limit) break;
          bytes += length;
          end += character.length;
        }
        output += text.slice(0, end);
        text = text.slice(end);
        overflow = await spill();
        file = await open(overflow, 'wx', 0o600);
      }
      await file.writeFile(text, 'utf8');
    }
    return { text: output, overflow };
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
  const spill = async (channel: string) =>
    join(await (temporary ??= mkdtemp(join(tmpdir(), 'mini-harness-output-'))), channel + '.log');
  child.stdin.end();
  const collect = (channel: 'stdout' | 'stderr') =>
    capture(
      child[channel],
      maxOutputBytes,
      () => spill(channel),
      (text) => write?.(text, channel),
    );
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
