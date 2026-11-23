import type { Context } from 'cordis';
import { HttpReply } from '../contracts/routes.js';
import { projectSession } from './navigation.js';

const validSession = /^[a-f0-9-]{36}$/;
const validWorkspace = /^[a-f0-9]{32}$/;

/** All session and run endpoints are registered in the session capability scope. */
export function registerSessionRoutes(ctx: Context) {
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const session = (id: string) => {
    if (!validSession.test(id) || !ctx.harnessRegistry.get(id)) throw new Error('Conversation not found');
    return id;
  };
  const workspace = (id: string) => {
    if (!validWorkspace.test(id)) throw new Error('Workspace not found');
    ctx.harnessWorkspaces.get(id);
    return id;
  };
  add('GET', '/api/sessions', ({ url }) => {
    const requested = new Set(url.searchParams.getAll('id'));
    if (requested.size > 100 || [...requested].some((id) => !validSession.test(id)))
      throw new Error('Invalid conversation selection');
    const records = requested.size ? [...requested].map((id) => ctx.harnessRegistry.get(id)).filter(Boolean) : ctx.harnessRegistry.list();
    return records.map((record) => projectSession(ctx, record));
  });
  add('POST', '/api/sessions', async ({ body }) => {
    const input = await body();
    if (input?.workspaceId !== undefined && typeof input.workspaceId !== 'string')
      throw new Error('Invalid workspace ID');
    return new HttpReply(201, projectSession(ctx, ctx.harnessRegistry.create({ workspaceId: input?.workspaceId })));
  });
  add('GET', '/api/workspaces/:id/sessions', ({ params }) =>
    ctx.harnessRegistry.list(workspace(params.id)).map((record) => projectSession(ctx, record)));
  add('POST', '/api/workspaces/:id/sessions', ({ params }) =>
    new HttpReply(201, projectSession(ctx, ctx.harnessRegistry.create({ workspaceId: workspace(params.id) }))));
  add('GET', '/api/sessions/:id', ({ params }) => ctx.harnessConversationView.read(session(params.id)));
  add('PATCH', '/api/sessions/:id', async ({ params, body }) => {
    const id = session(params.id), input = await body();
    if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 140)
      throw new Error('Title must contain 1–140 characters');
    return projectSession(ctx, ctx.harnessRegistry.rename(id, input.title.trim()));
  });
  add('DELETE', '/api/workspaces/:id', ({ params }) => ctx.harnessRegistry.deleteWorkspace(workspace(params.id)));
  add('POST', '/api/sessions/delete', async ({ body }) => {
    const input = await body();
    return { deleted: await ctx.harnessRegistry.delete(input.ids) };
  });
  add('POST', '/api/sessions/export', async ({ body, response }) => {
    const input = await body();
    if (!Array.isArray(input.ids) || input.ids.length > 200)
      return new HttpReply(400, { error: 'Invalid selection' });
    const records = ctx.harnessRegistry.export(input.ids);
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="mini-harness-sessions.json"', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), sessions: records }, null, 2));
  });
}
