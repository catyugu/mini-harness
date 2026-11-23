import type { Context } from 'cordis';


export function setup(ctx: Context) {
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/extensions/session-helper/revise', async ({ body }) => {
      const input = await body(20 * 1024 * 1024) as Record<string, unknown>;
      if (!input || typeof input.sessionId !== 'string' || typeof input.sourceEntryId !== 'string' ||
          !Object.hasOwn(input, 'expectedLeafId') || typeof input.message !== 'string')
        throw new Error('Invalid revision request');
      return ctx.harnessRuns.reviseAndStart(input.sessionId, {
        sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId as string | null,
        message: input.message, attachments: input.attachments as import('../contracts/input.js').Attachment[],
        model: input.model as import('../contracts/conversation.js').ModelChoice,
        thinkingLevel: input.thinkingLevel as import('../contracts/agent.js').ThinkingLevel
      });
    }));
}
