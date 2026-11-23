import type { Context } from 'cordis';
import { HttpReply } from '@mini-harness/contracts/routes';

export function registerRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!ctx.harnessRegistry.get(id)) throw new Error('Conversation not found');
    return id;
  };
  add('POST', '/api/sessions/:id/queue', async ({ params, body }) => {
    const id = session(params.id), input = await body(20 * 1024 * 1024);
    return new HttpReply(202, await ctx.harnessAgent.queueInput(id, input.message, input.mode, input.attachments,
      { model: input.model, thinkingLevel: input.thinkingLevel }));
  });
  add('GET', '/api/sessions/:id/queue', ({ params }) => ctx.harnessAgent.read(session(params.id)).queue);
}
