import type { Context } from 'cordis';


export function setup(ctx: Context) {
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/extensions/edit-resend/revise', async ({ body }) => {
      const input = await body(20 * 1024 * 1024) as Record<string, unknown>;
      if (!input || typeof input.sessionId !== 'string' || typeof input.sourceEntryId !== 'string' ||
          !Object.hasOwn(input, 'expectedLeafId') || typeof input.message !== 'string')
        throw new Error('Invalid revision request');
      return ctx.harnessRevision.reviseAndStart(input.sessionId, {
        sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId as string | null,
        message: input.message, attachments: input.attachments as import('../../src/input.js').Attachment[],
        model: input.model as import('../../src/registry.js').ModelChoice,
        thinkingLevel: input.thinkingLevel as import('../../src/adapters/pi/sessions.js').ThinkingLevel
      });
    }));
}
