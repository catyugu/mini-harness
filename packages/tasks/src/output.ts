import type { TaskChunk, TaskOutput } from './api.ts';

function boundary(bytes: Buffer, offset: number) {
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
  return offset;
}

/** Absolute UTF-8 byte positions survive eviction and independent consumer reads. */
export class TaskOutputRing {
  private chunks: TaskChunk[] = [];
  cursor = 0;

  constructor(private capacity = 1024 * 1024) {}

  write(text: string, channel: string) {
    const bytes = Buffer.from(text);
    if (!bytes.length) return;
    const start = this.cursor;
    this.cursor += bytes.length;
    this.chunks.push({ start, end: this.cursor, channel, text: bytes.toString('utf8') });
    this.trim();
  }

  private trim() {
    const minimum = this.cursor - this.capacity;
    while (this.chunks.length && (this.chunks[0].end <= minimum || this.chunks.length > 2048))
      this.chunks.shift();
    const first = this.chunks[0];
    if (first && first.start < minimum) {
      const bytes = Buffer.from(first.text);
      const cut = boundary(bytes, minimum - first.start);
      if (cut === bytes.length) this.chunks.shift();
      else
        this.chunks[0] = { ...first, start: first.start + cut, text: bytes.subarray(cut).toString('utf8') };
    }
  }

  read(after = 0): TaskOutput {
    return readTaskOutput({ cursor: this.cursor, truncated: false, chunks: this.chunks }, after);
  }
}

export function readTaskOutput(output: TaskOutput, after = 0): TaskOutput {
  const first = output.chunks[0]?.start ?? output.cursor;
  const chunks = output.chunks
    .filter(({ end }) => end > after)
    .map((chunk) => {
      if (after <= chunk.start) return { ...chunk };
      const bytes = Buffer.from(chunk.text);
      const cut = boundary(bytes, after - chunk.start);
      return { ...chunk, start: chunk.start + cut, text: bytes.subarray(cut).toString('utf8') };
    })
    .filter(({ text }) => text.length > 0);
  return {
    cursor: output.cursor,
    truncated: after < first || (chunks[0]?.start ?? output.cursor) > after,
    chunks,
  };
}
