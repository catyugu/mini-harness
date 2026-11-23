import { spawnSync } from 'node:child_process';

export function supportsIsolation(platform: NodeJS.Platform = process.platform, probe: typeof spawnSync = spawnSync) {
  if (platform !== 'linux') return false;
  try {
    return probe('bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', '/usr/bin/prlimit', '--', '/bin/true'], {
      stdio: 'ignore', timeout: 1500, env: { PATH: '/usr/bin:/bin' }
    }).status === 0;
  } catch { return false; }
}

