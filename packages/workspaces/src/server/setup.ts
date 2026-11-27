import { waitFor } from '@mini-harness/platform/wait';
import type { Context } from 'mini-harness/cordis';
import { applicationResources } from '@mini-harness/plugin-api/scopes';
import { WorkspaceCatalog } from './catalog.ts';
import { HttpError, HttpReply } from '@mini-harness/transport/routes';
const validId = /^[a-f0-9]{32}$/;

/** Workspace identity, mutations and registered HTTP routes have one owner. */
export function setup(ctx: Context) {
  const owner = applicationResources(ctx);
  const lifetime = ctx.fiber.signal;
  ctx.effect(function* () {
    yield ctx.harnessProfileScopes.register(owner, 'workspace', (id) => {
      const key = catalog.scope(id);
      return key && { key };
    });
    const catalog = new WorkspaceCatalog(ctx.harnessState.paths);
    yield owner.provide('harnessWorkspaces', catalog);
    yield () => catalog.close();
    ctx.effect(() => {
      const changed = (event: Event) => {
        void ctx.harnessProfileScopes
          .changed(`workspace:${(event as CustomEvent<string>).detail}`)
          .catch((error) => ctx.logger.error(error));
      };
      catalog.events.addEventListener('membership', changed);
      return () => catalog.events.removeEventListener('membership', changed);
    });
    const changes = ctx.harnessChanges;
    ctx.effect(() => changes.register('workspaces'));
    ctx.effect(() => {
      const changed = () => changes.invalidate('workspaces');
      catalog.events.addEventListener('change', changed);
      return () => catalog.events.removeEventListener('change', changed);
    });
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
          catalog.remove(id, () => ctx.harnessProfileConfig.forgetScopes([`workspace:${id}`], lifetime)),
          signal,
        );
      });
    });
  });
}
