import type { Context } from 'cordis';
import { WorkspaceCatalog } from './catalog.js';
import { HttpReply } from '../../src/contracts/routes.js';
const validId = /^[a-f0-9]{32}$/;

/** Workspace identity, mutations and registered HTTP routes have one owner. */
export function setup(ctx: Context) {
  const catalog = new WorkspaceCatalog(ctx.harnessState.paths);
  ctx.provide('harnessWorkspaces', catalog);
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const requireId = (id: string) => {
    if (!validId.test(id)) throw new Error('Workspace not found');
    catalog.get(id);
    return id;
  };
  add('GET', '/api/workspaces/directories', ({ url }) => catalog.browse(url.searchParams.get('path')));
  add('GET', '/api/workspaces', () => catalog.list());
  add('PUT', '/api/workspaces', async ({ body }) => catalog.reorder((await body())?.ids));
  add('POST', '/api/workspaces', async ({ body }) => {
    const input = await body();
    return new HttpReply(201, catalog.register(input?.path, input?.name));
  });
  add('PATCH', '/api/workspaces/:id', async ({ params, body }) =>
    catalog.rename(requireId(params.id), (await body())?.name));
  add('DELETE', '/api/workspaces/:id', ({ params }) =>
    ctx.harnessOperations.deleteWorkspace(requireId(params.id)));
}
