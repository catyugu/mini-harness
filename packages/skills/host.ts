import { join } from 'node:path';
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Context } from 'cordis';


export function setup(ctx: Context) {
    const { agent, skills } = ctx.harnessState.paths;
    const paths = (cwd: string) => [skills, join(cwd, '.mini-harness', 'skills')];
    ctx.provide('harnessSkills', { paths });
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/workspaces/:id/skills', async ({ params, url }) => {
      const workspace = ctx.harnessWorkspaces.get(params.id);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId && ctx.harnessRegistry.get(sessionId)?.workspaceId !== workspace.id)
        throw new Error('Conversation not found');
      const cwd = ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id);
      const loader = new DefaultResourceLoader({ cwd, agentDir: agent, settingsManager: SettingsManager.inMemory(),
        additionalSkillPaths: paths(cwd), noExtensions: true });
      await loader.reload();
      return loader.getSkills().skills.map(({ name, description }) => ({ name, description }));
    }));
}
