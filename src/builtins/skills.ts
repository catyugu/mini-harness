import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';
import type { BuiltinPlugin } from '../plugins.js';

export const skills: BuiltinPlugin = {
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/builtins/skills.js', inject: ['harnessState', 'harnessRoutes'],
  setup(ctx: Context) {
    const { cwd, agent, skills, projectSkills } = ctx.harnessState.paths;
    const paths = [skills, projectSkills];
    ctx.provide('harnessSkills', { paths });
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/skills', async () => {
      const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: SettingsManager.inMemory(),
        additionalSkillPaths: paths, noExtensions: true });
      await loader.reload();
      return loader.getSkills().skills.map(({ name, description }) => ({ name, description }));
    }));
  }
};
