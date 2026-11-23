import type { ServerResponse } from 'node:http';
import { isRunning } from '@mini-harness/contracts/transport';
import { eventStream } from '@mini-harness/transport/http';
import type { Context } from 'cordis';
import { HttpReply } from '@mini-harness/contracts/routes';

export function registerRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!ctx.harnessRegistry.get(id)) throw new Error('Conversation not found');
    return id;
  };
  function runEvents(id: string, runId: string, after: number, res: ServerResponse) {
    const stream = eventStream(res);
    const detach = ctx.harnessRuns.watch(id, runId, after, (event) => {
      stream.send(event);
      if ((event.type === 'run' || event.type === 'snapshot') && !isRunning(event.run)) res.end();
    });
    res.once('close', detach);
    stream.start();
  }

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
    return new HttpReply(202, ctx.harnessRuns.startRun(id, input.message, input));
  });
  add('GET', '/api/sessions/:id/events', async ({ params, url, response }) => {
    const id = session(params.id);
    const runId = url.searchParams.get('run');
    if (!runId) throw new Error('Run ID is required');
    runEvents(id, runId, Number(url.searchParams.get('after') ?? 0), response);
  });
}
