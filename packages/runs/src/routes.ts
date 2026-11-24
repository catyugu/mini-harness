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
    return new HttpReply(202, ctx.harnessRuns.queueInput(id, input));
  });
  add('DELETE', '/api/sessions/:id/queue', async ({ params, signal }) => {
    return ctx.harnessRuns.cancelQueue(session(params.id), undefined, signal);
  });
  add('DELETE', '/api/sessions/:id/queue/:item', async ({ params, signal }) => {
    return ctx.harnessRuns.cancelQueue(session(params.id), params.item, signal);
  });
  add('POST', '/api/sessions/:id/compact', async ({ params }) => {
    const id = session(params.id);
    await ctx.harnessRuns.compact(id);
    return { ok: true };
  });
  add('POST', '/api/sessions/:id/cancel', ({ params }) =>
    ({ cancelled: ctx.harnessRuns.cancel(session(params.id)) }));
  add('GET', '/api/sessions/:id/runs', ({ params }) =>
    ({ run: ctx.harnessRuns.info(session(params.id)) ?? null }));
  add('POST', '/api/sessions/:id/runs', async ({ params, body }) => {
    const id = session(params.id);
    const input = await body(20 * 1024 * 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError('invalid_input', 'Invalid run request');
    return new HttpReply(202, ctx.harnessRuns.startRun(id, input.message, input));
  });
}
