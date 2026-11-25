import { waitFor } from '@mini-harness/platform/wait';
import type { Context } from 'mini-harness/cordis';
import { WorkspaceCatalog } from './catalog.ts';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';
const validId = /^[a-f0-9]{32}$/;

/** Workspace identity, mutations and registered HTTP routes have one owner. */
export function setup(ctx: Context) {
  const catalog = new WorkspaceCatalog(ctx.harnessState.paths);
  const scopes = new Map<string, () => void>();
  const syncScopes = () => {
    const ids = new Set(catalog.list().map(({ id }) => id));
    for (const [id, release] of scopes) {
      if (ids.has(id)) continue;
      scopes.delete(id);
      release();
    }
    for (const id of ids) {
      if (scopes.has(id)) continue;
      scopes.set(id, ctx.harnessProfileScopes.register(ctx, `workspace:${id}`, { key: catalog.scope(id)! }));
    }
  };
  syncScopes();
  ctx.effect(() => {
    catalog.events.addEventListener('change', syncScopes);
    return () => catalog.events.removeEventListener('change', syncScopes);
  });
  ctx.on('settings/scopes', (options) => {
    for (const { id, name } of catalog.list()) options.push({ key: `workspace:${id}`, name });
  });
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('workspaces'));
  ctx.effect(() => {
    const changed = () => changes.invalidate('workspaces');
    catalog.events.addEventListener('change', changed);
    return () => catalog.events.removeEventListener('change', changed);
  });
  ctx.provide('harnessWorkspaces', catalog);
  ctx.on('harness/quiesce', () => catalog.close());
  ctx.inject(['harnessRoutes'], (web) => {
    const add = (method: string, path: string, handler: Parameters<typeof web.harnessRoutes.register>[2]) =>
      web.effect(() => web.harnessRoutes.register(method, path, handler));
    const requireId = (id: string) => {
      if (!validId.test(id)) throw new HttpError('not_found', 'Workspace not found');
      catalog.get(id);
      return id;
    };
    add('GET', '/api/workspaces/directories', ({ url }) =>
      catalog.browse(url.searchParams.get('path') ?? ''),
    );
    add('GET', '/api/workspaces', () => catalog.list());
    add('PUT', '/api/workspaces', async ({ body }) => catalog.reorder((await body())?.ids));
    add('POST', '/api/workspaces', async ({ body }) => {
      const input = await body();
      return new HttpReply(201, catalog.register(input?.path, input?.name));
    });
    add('PATCH', '/api/workspaces/:id', async ({ params, body }) =>
      catalog.rename(requireId(params.id), (await body())?.name),
    );
    add('DELETE', '/api/workspaces/:id', ({ params, signal }) => {
      const id = requireId(params.id);
      return waitFor(
        catalog.remove(id, () => ctx.harnessProfileConfig.forgetScopes([`workspace:${id}`])),
        signal,
      );
    });
  });
}
