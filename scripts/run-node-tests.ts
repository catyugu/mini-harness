import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** Discover Node suites across test/ and feature-owned tests on every OS; never ship them. */
function discover(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return discover(path);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [path] : [];
  });
}
const tests = [...discover('dist/test'), ...discover('dist/packages')].sort();
if (!tests.length) throw new Error('No Node tests found');
// npm and detached CLI fixtures also start subprocesses on the Windows runner.
const concurrency = process.platform === 'win32' ? '2' : '4';
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=' + concurrency, ...tests], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
