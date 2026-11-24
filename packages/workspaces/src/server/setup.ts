import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/kernel/mutation-api';
import type {} from '@mini-harness/settings/api';
import type {} from '@mini-harness/transport/projection-api';
import type { Context } from 'cordis';
import { WorkspaceCatalog } from './catalog.js';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';
const validId = /^[a-f0-9]{32}$/;

/** Workspace identity, mutations and registered HTTP routes have one owner. */
export function setup(ctx: Context) {
  const catalog = new WorkspaceCatalog(ctx.harnessState.paths);
  ctx.effect(() => ctx.harnessScopes.register('workspace', (id) => catalog.list().some((entry) => entry.id === id)
    ? { scope: { kind: 'workspace', workspaceId: id } }
    : undefined, true));
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('workspaces'));
  ctx.effect(() => {
    const changed = () => changes.invalidate('workspaces');
    catalog.events.addEventListener('change', changed);
    return () => catalog.events.removeEventListener('change', changed);
  });
  ctx.provide('harnessWorkspaces', catalog);
  ctx.on('harness/quiesce', () => catalog.close());
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const requireId = (id: string) => {
    if (!validId.test(id)) throw new HttpError('not_found', 'Workspace not found');
    catalog.get(id);
    return id;
  };
  add('GET', '/api/workspaces/directories', ({ url }) => catalog.browse(url.searchParams.get('path') ?? ''));
  add('GET', '/api/workspaces', () => catalog.list());
  add('PUT', '/api/workspaces', async ({ body }) => catalog.reorder((await body())?.ids));
  add('POST', '/api/workspaces', async ({ body }) => {
    const input = await body();
    return new HttpReply(201, catalog.register(input?.path, input?.name));
  });
  add('PATCH', '/api/workspaces/:id', async ({ params, body }) =>
    catalog.rename(requireId(params.id), (await body())?.name));
  add('DELETE', '/api/workspaces/:id', ({ params }) => {
    const id = requireId(params.id);
    return catalog.remove(id, () => ctx.harnessSettingsStore.forgetScopes(['workspace:' + id]));
  });
}
