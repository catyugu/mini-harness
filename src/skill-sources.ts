import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { DefaultResourceLoader, SettingsManager, loadSkills, type LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import type { getPaths } from './config.js';
import { containsPath } from './workspace.js';

export function skillSources(paths: ReturnType<typeof getPaths>, cwd: string) {
  return [
    { scope: 'workspace', path: join(cwd, '.mini-harness', 'skills') },
    { scope: 'global', path: paths.skills },
    { scope: 'global', path: join(paths.agent, 'skills') }
  ];
}

/** Keep Pi's native discovery, then resolve names with the application's precedence. */
export function harnessSkillOptions(paths: ReturnType<typeof getPaths>, cwd: string) {
  const [project, global, agent] = skillSources(paths, cwd).map(({ path }) => path);
  const ancestors: string[] = [];
  for (let path = cwd; ; path = dirname(path)) {
    ancestors.push(path);
    if (dirname(path) === path) break;
  }
  const userSkills = join(homedir(), '.agents', 'skills');
  const priority = (path: string, scope?: string) => {
    if (containsPath(project, path) && !containsPath(paths.home, path)) return 0;
    if (containsPath(global, path)) return 2;
    if (containsPath(agent, path)) return 3;
    if (!containsPath(paths.home, path) && !containsPath(userSkills, path) &&
      (scope === 'project' || containsPath(cwd, path) || ancestors.some((root) => containsPath(join(root, '.agents', 'skills'), path)))) return 1;
    return 4;
  };
  return {
    additionalSkillPaths: [project, global, agent].filter(existsSync),
    skillsOverride(base: LoadSkillsResult): LoadSkillsResult {
      const winners = new Map(base.skills.map((skill) => [skill.name, skill]));
      const candidates = base.diagnostics.flatMap(({ collision }) => {
        if (collision?.resourceType !== 'skill') return [];
        const winner = winners.get(collision.name);
        return priority(collision.loserPath) < priority(winner.filePath, winner.sourceInfo.scope) ? [collision.loserPath] : [];
      });
      if (!candidates.length) return base;

      // Pi 1.6 reports the original winner and each shadowed file by name.
      const loaded = loadSkills({ cwd, agentDir: paths.agent, includeDefaults: false,
        skillPaths: [...new Set(candidates)].sort((a, b) => priority(a) - priority(b)) });
      for (const skill of loaded.skills) winners.set(skill.name, skill);

      const diagnostics = base.diagnostics.map((item) => {
        const { collision } = item;
        if (collision?.resourceType !== 'skill') return item;
        const winnerPath = winners.get(collision.name).filePath;
        const loserPath = winnerPath === collision.loserPath ? collision.winnerPath : collision.loserPath;
        return { ...item, path: loserPath, collision: { ...collision, winnerPath, loserPath } };
      });
      return { skills: [...winners.values()], diagnostics: [...diagnostics, ...loaded.diagnostics.filter(({ type }) => type !== 'collision')] };
    }
  };
}

export async function loadHarnessSkills(paths: ReturnType<typeof getPaths>, cwd: string) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: paths.agent,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, ...harnessSkillOptions(paths, cwd) });
  await loader.reload();
  return loader.getSkills();
}
