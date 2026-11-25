import { realpath } from 'node:fs/promises';
import { relative } from 'node:path';
import { containsPath } from '@mini-harness/platform/paths';
import type { SandboxOptions, SandboxPort } from './api.ts';
import type { ProcessCommand } from '@mini-harness/process-execution/api';
import { supportsIsolation, bubblewrap } from '@mini-harness/platform/isolation';

function isolationCommand(
  { file, args = [], cwd, env }: ProcessCommand,
  { cpuSeconds, mounts = [] }: SandboxOptions,
): ProcessCommand {
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
      ...mounts.flatMap(({ source, target, readOnly }) => [
        readOnly ? '--ro-bind' : '--bind',
        source,
        target,
      ]),
      '--setenv',
      'PATH',
      '/usr/local/bin:/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/tmp',
      ...Object.entries(env ?? {}).flatMap(([name, value]) =>
        value === undefined ? [] : ['--setenv', name, value],
      ),
      '--',
      '/usr/bin/prlimit',
      '--nofile=1024',
      '--fsize=268435456',
      '--cpu=' + cpuSeconds,
      '--core=0',
      '--',
      file,
      ...args,
    ],
  };
}

export class LinuxSandbox implements SandboxPort {
  constructor(
    private readonly protectedRoot: string,
    private readonly platform = process.platform,
  ) {}

  async prepare(command: ProcessCommand, options: SandboxOptions) {
    const { cwd } = command;
    const { signal } = options;
    signal?.throwIfAborted();
    if (this.platform !== 'linux') throw new Error('Isolated shell requires Linux and bubblewrap');
    const [root, protectedRoot] = await Promise.all([realpath(cwd), realpath(this.protectedRoot)]);
    if (relative(root, cwd) || containsPath(root, protectedRoot) || containsPath(protectedRoot, root))
      throw new Error('Use a canonical working directory separate from protected storage');
    if (!supportsIsolation())
      throw new Error('Isolation unavailable: Linux bubblewrap namespaces and prlimit are required');
    signal?.throwIfAborted();
    return isolationCommand({ ...command, cwd: root }, options);
  }
}
