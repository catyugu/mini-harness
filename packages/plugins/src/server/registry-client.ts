import { spawn, spawnSync } from 'node:child_process';
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

/** Only registry resolution and package-lock creation; publication belongs to the plugin manager. */
export function installRegistryPackage(directory: string, spec: string, signal?: AbortSignal) {
  const args = [
    npmCli(),
    'install',
    '--save-prod',
    '--save-exact',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock',
    '--install-strategy=hoisted',
    '--',
    spec,
  ];
  const timeout = AbortSignal.timeout(120000);
  const cancellation = signal ? AbortSignal.any([signal, timeout]) : timeout;
  cancellation.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const windows = process.platform === 'win32';
    const child = spawn(process.execPath, args, {
      cwd: directory,
      stdio: 'inherit',
      detached: !windows,
      windowsHide: true,
    });
    const abort = () => {
      if (!child.pid) return;
      if (windows) {
        const result = spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 3000,
        });
        if (result.status !== 0) child.kill('SIGKILL');
      } else {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
        }
      }
    };
    cancellation.addEventListener('abort', abort, { once: true });
    let failure: Error | undefined;
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      cancellation.removeEventListener('abort', abort);
      if (cancellation.aborted)
        reject(
          new Error(
            timeout.aborted ? 'npm plugin installation timed out' : 'npm plugin installation cancelled',
          ),
        );
      else if (failure) reject(new Error('Could not start npm plugin installation', { cause: failure }));
      else if (code !== 0) reject(new Error('npm plugin installation failed (exit ' + code + ')'));
      else resolve();
    });
  });
}
