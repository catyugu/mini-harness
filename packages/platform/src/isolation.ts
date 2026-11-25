import { spawnSync } from 'node:child_process';

export const bubblewrap = '/usr/bin/bwrap';

export function supportsIsolation(
  platform: NodeJS.Platform = process.platform,
  probe: typeof spawnSync = spawnSync,
) {
  if (platform !== 'linux') return false;
  try {
    return (
      probe(
        bubblewrap,
        [
          '--unshare-all',
          '--cap-drop',
          'ALL',
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
          '--',
          '/usr/bin/prlimit',
          '--',
          '/bin/true',
        ],
        {
          stdio: 'ignore',
          timeout: 1500,
          env: { PATH: '/usr/bin:/bin' },
        },
      ).status === 0
    );
  } catch {
    return false;
  }
}
