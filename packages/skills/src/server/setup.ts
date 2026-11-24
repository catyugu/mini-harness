import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/workspaces/api';
import { sessionExtensions } from '@mini-harness/sessions/records';
import { toolExtensions } from '@mini-harness/tools/extensions';
import { DomainError } from '@mini-harness/platform/errors';
import { agentExtensions } from '@mini-harness/agent/extensions';
import { promptExtensions } from '@mini-harness/agent/prompt-api';
import type { Context } from 'cordis';
import { Type } from 'typebox';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import { defineTool } from '@mini-harness/tools/api';
import { SkillLoader, defaultSkillRoots } from './loader.js';

export function setup(ctx: Context, api: PluginApi) {
  const sessions = api.contribute(sessionExtensions.access);
  const loader = new SkillLoader(defaultSkillRoots(ctx.harnessState.paths.home),
    (path, error) => ctx.logger.warn('Could not discover skill at %s: %s', path, String(error)));
  api.contribute(agentExtensions.prepareInput, async (content, { source, original, cwd, signal }) => {
    if (source !== 'user') return;
    const invocation = await loader.invocation(cwd, original.userText);
    signal.throwIfAborted();
    if (!invocation) return;
    const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content;
    const first = parts[0];
    // Remove the invocation from the original text when it is still the first model-visible block.
    // Keep the suffix intact, including any text attachments added during input normalization.
    if (first?.type === 'text' && first.text.startsWith(original.userText)) {
      first.text = invocation.task + first.text.slice(original.userText.length);
      if (!first.text) parts.shift();
    }
    return [...parts, { type: 'text', text: invocation.instruction }];
  });
  api.contribute(promptExtensions.section, { id: 'skills', order: 400, render: ({ cwd }) => loader.prompt(cwd) });
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/workspaces/:id/skills', async ({ params, url, signal }) => {
    const workspace = ctx.harnessWorkspaces.get(params.id);
    const sessionId = url.searchParams.get('sessionId');
    if (sessionId) {
      if (sessions.get(sessionId)?.workspaceId !== workspace.id)
        throw new DomainError('not_found', 'Conversation not found');
      await api.prepareSession(sessionId, signal);
      if (api.signal.aborted) return [];
      return loader.list(sessions.workspacePath(sessionId));
    }
    return loader.list(ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id));
  }));
  api.contribute(toolExtensions.register, { name: 'load_skill', bind: (sessionId) => defineTool({
    name: 'load_skill', label: 'Load skill', description: 'Read the instructions for an available skill by name.',
    parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) }, { additionalProperties: false }),
    async execute(_callId, { name }, signal) {
      signal?.throwIfAborted();
      const skill = await loader.load(sessions.workspacePath(sessionId), name);
      signal?.throwIfAborted();
      return { content: [{ type: 'text', text: skill.content }], details: { skill: skill.name } };
    }
  }) }, { access: 'readOnly' });
}
