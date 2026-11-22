import { join } from 'node:path';
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
    additionalSkillPaths: skillSources(paths, cwd).map(({ path }) => path),
    skillsOverride(base: LoadSkillsResult): LoadSkillsResult {
      // Include losing native definitions too, so a global definition cannot hide a workspace one.
      const candidates = [...base.skills.map(({ filePath }) => filePath),
        ...base.diagnostics.filter(({ type }) => type === 'collision').map(({ path }) => path)];
      const workspace = candidates.filter((path) => containsPath(cwd, path) && !containsPath(paths.home, path));
      const user = candidates.filter((path) => !containsPath(cwd, path) && !containsPath(paths.home, path));
      const result = loadSkills({ cwd, agentDir: paths.agent, includeDefaults: false, skillPaths: [
        join(cwd, '.mini-harness', 'skills'), ...workspace, paths.skills, join(paths.agent, 'skills'), ...user
      ] });
      const native = new Map(base.skills.map((skill) => [skill.filePath, skill.sourceInfo]));
      return { ...result, skills: result.skills.map((skill) => ({ ...skill,
        sourceInfo: native.get(skill.filePath) ?? skill.sourceInfo })) };
    }
  };
}

export async function loadHarnessSkills(paths: ReturnType<typeof getPaths>, cwd: string) {
  const loader = new DefaultResourceLoader({ cwd, agentDir: paths.agent,
    settingsManager: SettingsManager.inMemory(), noExtensions: true, ...harnessSkillOptions(paths, cwd) });
  await loader.reload();
  return loader.getSkills();
}
