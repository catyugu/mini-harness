import { containsPath } from '../workspace.js';
import { loadHarnessSkills, skillSources } from '../skill-sources.js';
import type { Context } from 'cordis';
import type { BuiltinPlugin } from '../plugins.js';

export const skills: BuiltinPlugin = {
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/builtins/skills.js', inject: ['harnessState', 'harnessRoutes'],
  setup(ctx: Context) {
    const paths = ctx.harnessState.paths;
    ctx.provide('harnessSkills', { paths: (cwd) => skillSources(paths, cwd).map(({ path }) => path) });
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/workspace/skills', async ({ workspace }) => {
      if (!workspace) throw new Error('Workspace not found');
      const cwd = workspace.path;
      const loaded = await loadHarnessSkills(paths, cwd);
      return loaded.skills.map(({ name, description, filePath, sourceInfo }) => ({ name, description, filePath,
        source: skillSources(paths, cwd).find(({ path }) => containsPath(path, filePath))?.scope ?? (sourceInfo.scope === 'project' ? 'workspace' : 'user'),
        conflicts: loaded.diagnostics.filter((entry) => entry.type === 'collision' && entry.collision?.name === name).map(({ message }) => message) }));
    }));
  }
};
