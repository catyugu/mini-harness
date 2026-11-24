import type {} from '@mini-harness/sessions/store';
import type { Context } from 'cordis';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';

export function registerRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!ctx.harnessRegistry.get(id)) throw new HttpError('not_found', 'Conversation not found');
    return id;
  };
  add('POST', '/api/sessions/:id/queue', async ({ params, body }) => {
    const id = session(params.id), input = await body(20 * 1024 * 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError('invalid_input', 'Invalid queue request');
    return new HttpReply(202, await ctx.harnessAgent.queueInput(id, input.message, input.mode, input.attachments,
      { model: input.model, thinkingLevel: input.thinkingLevel }));
  });
  add('DELETE', '/api/sessions/:id/queue', ({ params }) => ctx.harnessAgent.cancelQueue(session(params.id)));
  add('DELETE', '/api/sessions/:id/queue/:item', ({ params }) => ctx.harnessAgent.cancelQueue(session(params.id), params.item));
}
