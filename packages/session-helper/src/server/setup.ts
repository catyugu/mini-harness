import { runExtensions } from '@mini-harness/runs/api';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import { DomainError } from '@mini-harness/platform/errors';
import type { Context } from 'cordis';


export function setup(_ctx: Context, api: PluginApi) {
    const runs = api.contribute(runExtensions.access);
    api.registerRoute('POST', '/revise', async ({ body, signal }) => {
      const input = await body(20 * 1024 * 1024) as Record<string, unknown>;
      if (!input || typeof input.sessionId !== 'string' || typeof input.sourceEntryId !== 'string' ||
          !Object.hasOwn(input, 'expectedLeafId') || typeof input.message !== 'string')
        throw new DomainError('invalid_input', 'Invalid revision request');
      return runs.revise(input.sessionId, {
        sourceEntryId: input.sourceEntryId, expectedLeafId: input.expectedLeafId as string | null,
        message: input.message, removedImages: input.removedImages as number[] | undefined, attachments: input.attachments as import('@mini-harness/input/message').Attachment[],
        model: input.model as import('@mini-harness/llm/vocabulary').ModelChoice,
        thinkingLevel: input.thinkingLevel as import('@mini-harness/llm/vocabulary').ThinkingLevel | null
      }, { userInitiated: true, signal });
    });
}
