import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Discover co-located Node tests on every OS. Never package fixtures or Playwright specs as test entries. */
function discover(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discover(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}
const tests = discover('dist').sort();
if (!tests.length) throw new Error('No Node tests found');
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=4', ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
