import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/agent/api';
import type {} from '@mini-harness/models/api';
import type { Context } from 'cordis';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';

export function registerRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!ctx.harnessRegistry.get(id)) throw new HttpError('not_found', 'Conversation not found');
    return id;
  };
  const agent = (id: string) => ctx.harnessScopes.require(id, 'harnessAgent');
  const queue = async (id: string, signal: AbortSignal) => {
    await ctx.harnessScopes.prepare(id, signal);
    return agent(id);
  };
  add('POST', '/api/sessions/:id/queue', async ({ params, body, signal }) => {
    const id = session(params.id), input = await body(20 * 1024 * 1024);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError('invalid_input', 'Invalid queue request');
    const fallback = ctx.harnessModelPreference.recent();
    const execution = await queue(id, signal);
    return new HttpReply(202, await execution.queueInput(id, input.message, input.mode, input.attachments,
      { model: input.model, thinkingLevel: input.thinkingLevel, fallback }));
  });
  add('DELETE', '/api/sessions/:id/queue', async ({ params, signal }) => {
    const id = session(params.id);
    return (await queue(id, signal)).cancelQueue(id);
  });
  add('DELETE', '/api/sessions/:id/queue/:item', async ({ params, signal }) => {
    const id = session(params.id);
    return (await queue(id, signal)).cancelQueue(id, params.item);
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
