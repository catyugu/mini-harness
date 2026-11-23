import { HttpError } from '@mini-harness/contracts/routes';
import type { Context } from 'cordis';


export function setup(ctx: Context) {
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/extensions/session-helper/revise', async ({ body }) => {
      const input = await body(20 * 1024 * 1024) as Record<string, unknown>;
      if (!input || typeof input.sessionId !== 'string' || typeof input.sourceEntryId !== 'string' ||
          !Object.hasOwn(input, 'expectedLeafId') || typeof input.message !== 'string')
        throw new HttpError('invalid_input', 'Invalid revision request');
      return ctx.harnessRuns.reviseAndStart(input.sessionId, {
        sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId as string | null,
        message: input.message, attachments: input.attachments as import('@mini-harness/contracts/input').Attachment[],
        model: input.model as import('@mini-harness/contracts/conversation').ModelChoice,
        thinkingLevel: input.thinkingLevel as import('@mini-harness/contracts/agent').ThinkingLevel
      });
    }));
}
