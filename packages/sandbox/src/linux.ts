import type { SandboxOptions, SandboxPort } from './api.ts';
import type { ProcessCommand } from '@mini-harness/process-execution/api';
import { supportsIsolation, bubblewrap } from '@mini-harness/platform/isolation';

function isolationCommand(
  { file, args = [], cwd, env }: ProcessCommand,
  { workingDirectory, limits, mounts = [] }: SandboxOptions,
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
      ...mounts.flatMap(({ source, target, readOnly }) => [
        readOnly ? '--ro-bind' : '--bind',
        source,
        target,
      ]),
      '--chdir',
      workingDirectory,
      ...Object.entries(env ?? {}).flatMap(([name, value]) =>
        value === undefined ? [] : ['--setenv', name, value],
      ),
      '--',
      ...(limits
        ? [
            '/usr/bin/prlimit',
            ...[
              ['cpu', limits.cpuSeconds],
              ['nofile', limits.openFiles],
              ['fsize', limits.fileBytes],
              ['core', limits.coreBytes],
            ].flatMap(([name, value]) => (value === undefined ? [] : ['--' + name + '=' + value])),
            '--',
          ]
        : []),
      file,
      ...args,
    ],
  };
}

export class LinuxSandbox implements SandboxPort {
  constructor(private readonly platform = process.platform) {}

  async prepare(command: ProcessCommand, options: SandboxOptions) {
    options.signal?.throwIfAborted();
    if (this.platform !== 'linux') throw new Error('Isolation requires Linux and bubblewrap');
    if (!supportsIsolation())
      throw new Error('Isolation unavailable: Linux bubblewrap namespaces and prlimit are required');
    return isolationCommand(command, options);
  }
}
