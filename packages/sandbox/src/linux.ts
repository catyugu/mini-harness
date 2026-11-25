import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { containsPath } from '@mini-harness/platform/paths';
import type { IsolatedProcess, SandboxPort } from './api.ts';
import type { ProcessRequest } from '@mini-harness/execution/request';
import { supportsIsolation, bubblewrap } from '@mini-harness/platform/isolation';

export function isolationCommand(
  command: string,
  cwd: string,
  timeout: number,
  attachments?: string,
): IsolatedProcess {
  return {
    file: bubblewrap,
    cwd,
    env: { PATH: '/usr/bin:/bin' },
    args: [
      '--die-with-parent',
      '--unshare-all',
      '--cap-drop',
      'ALL',
      '--clearenv',
      '--ro-bind',
      '/usr',
      '/usr',
      '--ro-bind-try',
      '/bin',
      '/bin',
      '--ro-bind-try',
      '/lib',
      '/lib',
      '--ro-bind-try',
      '/lib64',
      '/lib64',
      '--ro-bind-try',
      '/etc/ld.so.cache',
      '/etc/ld.so.cache',
      '--ro-bind-try',
      '/etc/alternatives',
      '/etc/alternatives',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--tmpfs',
      '/tmp',
      '--bind',
      cwd,
      '/workspace',
      '--chdir',
      '/workspace',
      ...(attachments
        ? ['--ro-bind', attachments, '/attachments', '--setenv', 'MINI_HARNESS_ATTACHMENTS', '/attachments']
        : []),
      '--setenv',
      'PATH',
      '/usr/local/bin:/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp',
      '--',
      '/usr/bin/prlimit',
      '--nofile=1024',
      '--fsize=268435456',
      '--cpu=' + timeout,
      '--core=0',
      '--',
      '/bin/sh',
      '-c',
      command,
    ],
  };
}

export class LinuxSandbox implements SandboxPort {
  constructor(
    private readonly stateDir: string,
    private readonly platform = process.platform,
  ) {}

  async prepare({ command, cwd, timeoutSeconds, signal }: ProcessRequest, attachments?: string) {
    signal?.throwIfAborted();
    if (this.platform !== 'linux') throw new Error('Isolated shell requires Linux and bubblewrap');
    const [root, state] = await Promise.all([realpath(cwd), realpath(this.stateDir)]);
    if (relative(root, cwd) || containsPath(root, state) || containsPath(state, root))
      throw new Error('Use a canonical workspace separate from mini-harness storage for isolated shell');
    if (!supportsIsolation())
      throw new Error('Isolation unavailable: Linux bubblewrap namespaces and prlimit are required');
    signal?.throwIfAborted();
    return isolationCommand(command, root, timeoutSeconds, attachments);
  }
}
