import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function readJson<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return structuredClone(fallback);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file: string, value: unknown) {
  writeText(file, JSON.stringify(value, null, 2) + '\n');
}

export function writeText(file: string, value: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + randomUUID() + '.tmp';
  const handle = openSync(temp, 'wx', 0o600);
  try {
    try {
      writeFileSync(handle, value);
      fsyncSync(handle);
    } finally { closeSync(handle); }
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
}
