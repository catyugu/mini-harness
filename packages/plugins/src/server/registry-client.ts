import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** npm comes with regular Node installations; no package manager is shipped with mini-harness. */
export function npmCli(env: NodeJS.ProcessEnv = process.env) {
  const cli =
    env.MINI_HARNESS_NPM_CLI ??
    resolve(
      dirname(process.execPath),
      process.platform === 'win32'
        ? 'node_modules/npm/bin/npm-cli.js'
        : '../lib/node_modules/npm/bin/npm-cli.js',
    );
  try {
    accessSync(cli, constants.R_OK);
  } catch {
    throw new Error(
      'npm CLI was not found alongside Node. Install Node with npm or set MINI_HARNESS_NPM_CLI.',
    );
  }
  return cli;
}

/** Use the selected Profile's ordinary npm dependency environment. */
export function runPackageManager(directory: string, args: readonly string[]) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli(), ...args], {
      cwd: directory,
      env: { ...process.env, npm_config_ignore_scripts: process.env.npm_config_ignore_scripts ?? 'true' },
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error('npm failed (' + (signal ?? code) + ')'));
    });
  });
}
