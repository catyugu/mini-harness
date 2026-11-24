import { toolExtensions } from '@mini-harness/contracts/tool-extensions';
import { HttpError } from '@mini-harness/contracts/routes';
import { agentExtensions } from '@mini-harness/contracts/agent-extensions';
import { promptExtensions } from '@mini-harness/contracts/prompt-extensions';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '@mini-harness/contracts/plugins';
import { defineTool } from '@mini-harness/contracts/tools';
import { SkillLoader, defaultSkillRoots } from './loader.js';

export function setup(ctx: Context, api: PluginApi) {
  const loader = new SkillLoader(defaultSkillRoots(ctx.harnessState.paths.home),
    (path, error) => ctx.logger.warn('Could not discover skill at %s: %s', path, String(error)));
  api.contribute(agentExtensions.prepareInput, async (content, { source, original, cwd, signal }) => {
    if (source !== 'user') return;
    const instruction = await loader.instruction(cwd, original.userText);
    signal.throwIfAborted();
    if (!instruction) return;
    const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
    return [...parts, { type: 'text', text: instruction }];
  });
  api.contribute(promptExtensions.section, { id: 'skills', order: 400, render: ({ cwd }) => loader.prompt(cwd) });
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/workspaces/:id/skills', async ({ params, url, signal }) => {
    const workspace = ctx.harnessWorkspaces.get(params.id);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId) {
      if (ctx.harnessRegistry.get(sessionId)?.workspaceId !== workspace.id)
        throw new HttpError('not_found', 'Conversation not found');
      await ctx.harnessScopes.prepare(sessionId, signal);
      if (api.signal.aborted) return [];
      return loader.list(ctx.harnessRegistry.workspacePath(sessionId));
    }
    return loader.list(ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id));
  }));
  api.contribute(toolExtensions.register, { name: 'load_skill', bind: (sessionId) => defineTool({
    name: 'load_skill', label: 'Load skill', description: 'Read the instructions for an available skill by name.',
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
    async execute(_callId, { name }, signal) {
      signal?.throwIfAborted();
      const skill = await loader.load(ctx.harnessRegistry.workspacePath(sessionId), name);
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: skill.content }], details: { skill: skill.name } };
    }
  }) }, { access: 'readOnly' });
}
