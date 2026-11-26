import type { Context } from 'mini-harness/cordis';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';

export function registerRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!ctx.harnessSessions.get(id)) throw new HttpError('not_found', 'Conversation not found');
    return id;
  };
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
  add('POST', '/api/sessions/:id/cancel', ({ params }) => ({
    cancelled: ctx.harnessRuns.stop(session(params.id)),
  }));
  add(
    'GET',
    '/api/sessions/:id/runs/:run/input',
    ({ params }) => ctx.harnessRuns.retryInput(session(params.id), params.run) ?? null,
  );
  add('GET', '/api/sessions/:id/runs', ({ params }) => ({
    run: ctx.harnessRuns.info(session(params.id)) ?? null,
  }));
  add('POST', '/api/sessions/:id/runs', async ({ params, body }) => {
    const id = session(params.id);
    const input = await body(20 * 1024 * 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new HttpError('invalid_input', 'Invalid run request');
    const { message, model, attachments, thinkingLevel, mode } = input;
    return new HttpReply(
      202,
      ctx.harnessRuns.send(id, {
        message,
        model,
        attachments,
        thinkingLevel,
        mode,
        origin: { source: 'user' },
      }),
    );
  });
}
