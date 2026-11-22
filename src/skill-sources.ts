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
      const rank = (skill: LoadSkillsResult['skills'][number]) => priority(skill.filePath, skill.sourceInfo.scope);
      const candidates = new Set<string>();
      for (const diagnostic of base.diagnostics) {
        if (diagnostic.type !== 'collision') continue;
        const loser = diagnostic.collision?.loserPath ?? diagnostic.path;
        const winner = winners.get(diagnostic.collision?.name);
        if (loser && (!winner || priority(loser) < rank(winner))) candidates.add(loser);
      }
      // Pi has already scanned all roots. Reopen only shadowed files that could win.
      const loaded = candidates.size ? loadSkills({ cwd, agentDir: paths.agent, includeDefaults: false,
        skillPaths: [...candidates].sort((a, b) => priority(a) - priority(b)) }) : { skills: [], diagnostics: [] };
      const promoted = new Map<string, string>();
      for (const skill of loaded.skills) {
        const previous = winners.get(skill.name);
        if (!previous || rank(skill) < rank(previous)) {
          if (previous) promoted.set(skill.name, previous.filePath);
          winners.set(skill.name, skill);
        }
      }
      const namesByPath = new Map(loaded.skills.map(({ name, filePath }) => [filePath, name]));
      for (const { collision } of loaded.diagnostics)
        if (collision) namesByPath.set(collision.loserPath, collision.name);
      const diagnostics = base.diagnostics.map((item) => {
        if (item.type !== 'collision') return item;
        const path = item.collision?.loserPath ?? item.path;
        const name = item.collision?.name ?? namesByPath.get(path);
        const winnerPath = winners.get(name)?.filePath;
        if (!path || !winnerPath) return item;
        const loserPath = path === winnerPath ? promoted.get(name) : path;
        if (!loserPath) return item;
        return { ...item, path: loserPath, collision: { ...item.collision, resourceType: 'skill' as const, name, winnerPath, loserPath } };
      });
      return {
        diagnostics: [...diagnostics, ...loaded.diagnostics.filter(({ type }) => type !== 'collision')],
        skills: [...winners.values()].map((skill) => ({ ...skill, sourceInfo: {
          ...skill.sourceInfo, scope: rank(skill) < 2 ? 'project' : 'user'
        } }))
      };
    }
  };
}

export async function loadHarnessSkills(paths: ReturnType<typeof getPaths>, cwd: string) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: paths.agent,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, ...harnessSkillOptions(paths, cwd) });
  await loader.reload();
  return loader.getSkills();
}
