import { DomainError } from '@mini-harness/platform/errors';
import type { Context } from 'mini-harness/cordis';
import { Type } from 'typebox';
import { defineTool } from '@mini-harness/tools/api';
import { SkillLoader, defaultSkillRoots, skillInstruction } from './loader.ts';

export function setup(ctx: Context) {
  const sessions = ctx.harnessSessions;
  const loader = new SkillLoader(defaultSkillRoots(ctx.harnessState.paths.home), (path, error) =>
    ctx.logger.warn('Could not discover skill at %s: %s', path, String(error)),
  );
  ctx.on('agent/prepare-input', async (content, { source, original, cwd, signal }) => {
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
  ctx.effect(() =>
    ctx.harnessPrompt.register({
      id: 'skills',
      order: 400,
      render: ({ cwd }) => loader.prompt(typeof cwd === 'string' ? cwd : undefined),
    }),
  );
  ctx.inject(['harnessRoutes'], (web) => {
    web.effect(() =>
      web.harnessRoutes.register('GET', '/api/workspaces/:id/skills', async ({ params, url, signal }) => {
        const workspace = ctx.harnessWorkspaces.get(params.id);
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId) {
          if (sessions.get(sessionId)?.workspaceId !== workspace.id)
            throw new DomainError('not_found', 'Conversation not found');
          await ctx.harnessProfileScopes.prepare(`session:${sessionId}`, signal);
          if (ctx.fiber.signal.aborted) return [];
          return loader.list(sessions.workspacePath(sessionId));
        }
        return loader.list(ctx.harnessWorkspaces.resolveRoot(workspace.path, workspace.id));
      }),
    );
  });
  ctx.effect(() =>
    ctx.harnessTools.register({
      name: 'load_skill',
      resolve: (sessionId) =>
        defineTool({
          name: 'load_skill',
          tags: ['readOnly'],
          label: 'Load skill',
          description: 'Read the instructions for an available skill by name.',
          parameters: Type.Object(
            { name: Type.String({ minLength: 1, maxLength: 64 }) },
            { additionalProperties: false },
          ),
          async execute({ name }, { signal }) {
            signal?.throwIfAborted();
            const skill = await loader.load(sessions.workspacePath(sessionId), name);
            signal?.throwIfAborted();
            return {
              content: [{ type: 'text', text: skillInstruction(skill) }],
              details: { skill: skill.name },
            };
          },
        }),
    }),
  );
}
