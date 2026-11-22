import type { Context } from 'cordis';
import type { ServerResponse } from 'node:http';
import { HttpReply } from '../../src/contracts/routes.js';
import { isRunning } from '../../src/contracts/transport.js';
import { eventStream } from '../../src/transport/http.js';
import { navigationSession, streamNavigation } from '../../src/transport/navigation-events.js';

const validSession = /^[a-f0-9-]{36}$/;
const validWorkspace = /^[a-f0-9]{32}$/;

/** All session and run endpoints are registered in the session capability scope. */
export function registerSessionRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const host = () => ({ registry: ctx.harnessRegistry, plugins: { ctx } });
  const session = (id: string) => {
    if (!validSession.test(id) || !ctx.harnessRegistry.get(id)) throw new Error('Conversation not found');
    return id;
  };
  const workspace = (id: string) => {
    if (!validWorkspace.test(id)) throw new Error('Workspace not found');
    ctx.harnessWorkspaces.get(id);
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

  add('GET', '/api/navigation/events', ({ response }) =>
    streamNavigation(host(), response, ctx.harnessTransportSignal ?? new AbortController().signal));
  add('GET', '/api/sessions', () => ctx.harnessRegistry.list().map(({ id }) => navigationSession(host(), id)));
  add('POST', '/api/sessions', async ({ body }) => {
    const input = await body();
    if (input?.workspaceId !== undefined && typeof input.workspaceId !== 'string')
      throw new Error('Invalid workspace ID');
    return new HttpReply(201, ctx.harnessOperations.createConversation({ workspaceId: input?.workspaceId }));
  });
  add('GET', '/api/workspaces/:id/sessions', ({ params }) =>
    ctx.harnessRegistry.list(workspace(params.id)).map(({ id }) => navigationSession(host(), id)));
  add('POST', '/api/workspaces/:id/sessions', ({ params }) =>
    new HttpReply(201, ctx.harnessOperations.createConversation({ workspaceId: workspace(params.id) })));
  add('GET', '/api/sessions/:id', ({ params }) => ctx.harnessOperations.getConversation(session(params.id)));
  add('PATCH', '/api/sessions/:id', async ({ params, body }) => {
    const id = session(params.id), input = await body();
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 140)
      throw new Error('Title must contain 1–140 characters');
    return ctx.harnessRegistry.update(id, { title: input.title.trim() });
  });
  add('POST', '/api/sessions/:id/compact', async ({ params }) => {
    const id = session(params.id);
    if (ctx.harnessMutations.changing || ctx.harnessSettingsStore.changing)
      throw new Error('Configuration is changing');
    await ctx.harnessRuns.compact(id);
    return { ok: true };
  });
  add('POST', '/api/sessions/:id/queue', async ({ params, body }) => {
    const id = session(params.id), input = await body(20 * 1024 * 1024);
    return new HttpReply(202, await ctx.harnessPi.queueInput(id, input.message, input.mode, input.attachments));
  });
  add('GET', '/api/sessions/:id/queue', async ({ params }) =>
    ctx.harnessPi.queue(await ctx.harnessPi.open(session(params.id))));
  add('POST', '/api/sessions/:id/cancel', ({ params }) =>
    ({ cancelled: ctx.harnessRuns.cancel(session(params.id)) }));
  add('GET', '/api/sessions/:id/runs', ({ params }) =>
    ({ run: ctx.harnessRuns.info(session(params.id)) ?? null }));
  add('POST', '/api/sessions/:id/runs', async ({ params, body }) => {
    const id = session(params.id);
    if (ctx.harnessMutations.changing || ctx.harnessSettingsStore.changing)
      throw new Error('Configuration is changing');
    const input = await body(20 * 1024 * 1024);
    return new HttpReply(202, ctx.harnessRuns.startRun(id, input.message, input));
  });
  add('GET', '/api/sessions/:id/events', async ({ params, url, response }) => {
    const id = session(params.id);
    await ctx.harnessPi.open(id);
    runEvents(id, url.searchParams.get('run'), Number(url.searchParams.get('after') ?? 0), response);
  });
  add('POST', '/api/sessions/delete', async ({ body }) => {
    const input = await body();
    return { deleted: await ctx.harnessOperations.delete(input.ids) };
  });
  add('POST', '/api/sessions/export', async ({ body, response }) => {
    const input = await body();
    if (!Array.isArray(input.ids) || input.ids.length > 200)
      return new HttpReply(400, { error: 'Invalid selection' });
    const records = ctx.harnessOperations.export(input.ids);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mini-harness-sessions.json"', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), sessions: records }, null, 2));
  });
}
