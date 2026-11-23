import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** npm comes with regular Node installations; no package manager is shipped with mini-harness. */
export function npmCli(env: NodeJS.ProcessEnv = process.env) {
  const cli = env.MINI_HARNESS_NPM_CLI ?? resolve(dirname(process.execPath),
    process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  try { accessSync(cli, constants.R_OK); }
  catch { throw new Error('npm CLI was not found alongside Node. Install Node with npm or set MINI_HARNESS_NPM_CLI.'); }
  return cli;
}

/** Only registry resolution and package-lock creation; publication belongs to the plugin manager. */
export function installRegistryPackage(directory: string, spec: string) {
  const args = [npmCli(), 'install', '--save-prod', '--save-exact', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock', '--install-strategy=hoisted', '--', spec];
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: directory, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('npm plugin installation failed (exit ' + code + ')')));
  });
}
