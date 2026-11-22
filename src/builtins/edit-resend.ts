import type { BuiltinPlugin } from '../plugin-api.js';

export const editResend: BuiltinPlugin = {
  id: 'edit-resend', title: 'Edit and resend', description: 'Revise a user message and create a Pi conversation branch.',
  icon: 'edit', browser: '/builtins/edit-resend.js', inject: ['harnessRevision', 'harnessRoutes'],
  setup(ctx) {
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/extensions/edit-resend/revise', async ({ body }) => {
      const input = await body(20 * 1024 * 1024) as Record<string, unknown>;
      if (!input || typeof input.sessionId !== 'string' || typeof input.sourceEntryId !== 'string' ||
          !Object.hasOwn(input, 'expectedLeafId') || typeof input.message !== 'string')
        throw new Error('Invalid revision request');
      return ctx.harnessRevision.reviseAndStart(input.sessionId, {
        sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId as string | null,
        message: input.message, attachments: input.attachments as import('../input.js').Attachment[],
        model: input.model as import('../registry.js').ModelChoice,
        thinkingLevel: input.thinkingLevel as import('../pi-sessions.js').ThinkingLevel
      });
    }));
  }
};
