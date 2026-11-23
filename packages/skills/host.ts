import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '@mini-harness/contracts/plugins';
import { defineTool } from '@mini-harness/contracts/tools';
import { SkillLoader } from './loader.js';

export function setup(ctx: Context, api: PluginApi) {
    const loader = new SkillLoader(ctx.harnessState.paths.skills);
    ctx.provide('harnessSkills', loader);
    api.promptSection({ id: 'skills', order: 400, render: ({ sessionId, cwd }) =>
      ctx.harnessScopes.require(sessionId, 'harnessSkills').prompt(cwd) });
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/workspaces/:id/skills', async ({ params, url }) => {
      const workspace = ctx.harnessWorkspaces.get(params.id);
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId && ctx.harnessRegistry.get(sessionId)?.workspaceId !== workspace.id)
        throw new Error('Conversation not found');
      const cwd = ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id);
      return (await loader.discover(cwd)).map(({ name, description }) => ({ name, description }));
    }));
    ctx.effect(() => ctx.harnessTools.register('load_skill', (sessionId) => defineTool({
      name: 'load_skill', label: 'Load skill', description: 'Read the instructions for an available skill by name.',
      parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
      async execute(_callId, { name }, signal) {
        signal?.throwIfAborted();
        const skill = (await loader.discover(ctx.harnessRegistry.workspacePath(sessionId))).find((item) => item.name === name);
        signal?.throwIfAborted();
        if (!skill) throw new Error('Unknown skill: ' + name);
        return { content: [{ type: 'text', text: skill.content }], details: { skill: skill.name } };
      }
    })));
}
