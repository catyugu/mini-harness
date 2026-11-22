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
  return {
    additionalSkillPaths: skillSources(paths, cwd).map(({ path }) => path).filter(existsSync),
    skillsOverride(base: LoadSkillsResult): LoadSkillsResult {
      // Include losing native definitions too, so a global definition cannot hide a workspace one.
      const candidates = [...base.skills.map(({ filePath }) => filePath),
        ...base.diagnostics.filter(({ type }) => type === 'collision').map(({ path }) => path)];
      const native = new Map(base.skills.map((skill) => [skill.filePath, skill.sourceInfo]));
      const ancestors: string[] = [];
      for (let path = cwd; ; path = dirname(path)) { ancestors.push(path); if (dirname(path) === path) break; }
      const isWorkspace = (path: string) => {
        if (containsPath(paths.home, path) || containsPath(join(homedir(), '.agents', 'skills'), path)) return false;
        return native.get(path)?.scope === 'project' || containsPath(cwd, path) ||
          ancestors.some((root) => containsPath(join(root, '.agents', 'skills'), path));
      };
      const workspace = candidates.filter(isWorkspace);
      const user = candidates.filter((path) => !isWorkspace(path) && !containsPath(paths.home, path));
      const result = loadSkills({ cwd, agentDir: paths.agent, includeDefaults: false, skillPaths: [
        join(cwd, '.mini-harness', 'skills'), ...workspace, paths.skills, join(paths.agent, 'skills'), ...user
      ].filter(existsSync) });
      return { ...result, diagnostics: [...result.diagnostics, ...base.diagnostics.filter(({ type }) => type !== 'collision')].filter((item, index, all) => all.findIndex((other) => other.path === item.path && other.message === item.message) === index), skills: result.skills.map((skill) => ({ ...skill,
        sourceInfo: { ...(native.get(skill.filePath) ?? skill.sourceInfo), scope: isWorkspace(skill.filePath) ? 'project' : 'user' } })) };
    }
  };
}

export async function loadHarnessSkills(paths: ReturnType<typeof getPaths>, cwd: string) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: paths.agent,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, ...harnessSkillOptions(paths, cwd) });
  await loader.reload();
  return loader.getSkills();
}
