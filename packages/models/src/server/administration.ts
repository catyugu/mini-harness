import { DomainError } from '@mini-harness/platform/errors';
import type { Context } from 'mini-harness/cordis';
import { providerId } from './provider-settings.ts';

export function setupAdministration(ctx: Context) {
  const recent = () => ctx.get('harnessModelPreference')?.recent() ?? { provider: '', id: '' };
  const catalog = ctx.harnessModels;
  const providerAdministration = () => ctx.get('harnessProviderAdministration');
  const admin = () => {
    const store = providerAdministration();
    if (!store) throw new DomainError('unavailable', 'Provider administration is disabled');
    return store;
  };
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  add('GET', '/api/providers', () => providerAdministration()?.providers() ?? []);
  add('GET', '/api/providers/:id/default-models', ({ params }) =>
    admin().defaultModels(providerId(params.id)),
  );
  add('POST', '/api/providers/discovery', async ({ body, signal }) =>
    admin().discoverModels(await body(), signal),
  );
  for (const method of ['PUT', 'DELETE']) {
    add(method, '/api/providers', async ({ body, signal }) => {
      const input: unknown = await body();
      signal.throwIfAborted();
      const store = admin();
      const id = await (method === 'PUT' ? store.saveProvider(input) : store.removeProvider(input));
      return { id };
    });
  }
  add('GET', '/api/models', async () => {
    const models = await catalog.available();
    const providerAdmin = providerAdministration();
    return {
      models,
      recent: recent(),
      canManageProviders: Boolean(providerAdmin),
      protocols: providerAdmin?.protocols() ?? [],
    };
  });
}
