import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import type { BuiltinPlugin } from '../plugin-api.js';

export const skills: BuiltinPlugin = {
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/builtins/skills.js', inject: ['harnessState', 'harnessRoutes'],
  setup(ctx: Context) {
    const { agent, skills } = ctx.harnessState.paths;
    const paths = (cwd: string) => [skills, join(cwd, '.mini-harness', 'skills')];
    ctx.provide('harnessSkills', { paths });
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/workspace/skills', async ({ workspace }) => {
      if (!workspace) throw new Error('Workspace not found');
      const cwd = workspace.path;
      const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: SettingsManager.inMemory(),
        additionalSkillPaths: paths(cwd), noExtensions: true });
      await loader.reload();
      return loader.getSkills().skills.map(({ name, description }) => ({ name, description }));
    }));
  }
};
