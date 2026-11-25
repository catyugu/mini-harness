import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifest: { bin: Record<string, string> } = JSON.parse(readFileSync('package.json', 'utf8'));

export const cliEntry = resolve(manifest.bin['mini-harness']);
