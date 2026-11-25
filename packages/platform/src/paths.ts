import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Paths } from './runtime-paths.ts';
import { relative, isAbsolute, join, resolve, sep } from 'node:path';

export function containsPath(root: string, candidate: string) {
  const name = relative(root, candidate);
  return !isAbsolute(name) && name !== '..' && !name.startsWith('..' + sep);
}

export function getPaths(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): Paths {
  const project = resolve(cwd);
  const home = resolve(env.MINI_HARNESS_HOME || join(homedir(), '.mini-harness'));
  const key = createHash('sha256')
    .update(process.platform === 'win32' ? project.toLowerCase() : project)
    .digest('hex')
    .slice(0, 16);
  return {
    home,
    cwd: project,
    settings: join(home, 'settings.json'),
    registry: join(home, 'sessions.json'),
    sessions: join(home, 'sessions', key),
    pid: join(home, 'server.json'),
    log: join(home, 'server.log'),
    plugins: join(home, 'plugins'),
  };
}

export function ensurePaths(paths: Paths) {
  for (const path of [paths.home, paths.sessions, paths.plugins]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}
