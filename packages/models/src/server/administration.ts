import { waitFor } from '@mini-harness/platform/wait';
import { DomainError } from '@mini-harness/platform/errors';
import type { Context } from 'mini-harness/cordis';
import { saveProvider } from './provider-settings.ts';

export function setupAdministration(ctx: Context) {
  const recent = () => ctx.get('harnessModelPreference')?.recent() ?? { provider: '', id: '' };
  const catalog = ctx.harnessModels;
  const providerAdministration = () => ctx.get('harnessModelStore');
  const admin = () => {
    const store = providerAdministration();
    if (!store) throw new DomainError('unavailable', 'Provider administration is disabled');
    return store;
  };
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('models'));
  const changed = () => changes.invalidate('models');
  let pending = Promise.resolve();
  const write = <T>(operation: () => Promise<T>) => {
    const work = pending.then(operation);
    pending = work.then(
      () => {},
      () => {},
    );
    return work;
  };
  ctx.effect(() => () => pending);
  add('GET', '/api/providers', () => providerAdministration()?.providers() ?? []);
  for (const method of ['PUT', 'DELETE']) {
    add(method, '/api/providers', async ({ body, signal }) => {
      const input = await body();
      return write(async () => {
        signal.throwIfAborted();
        const result = await saveProvider(
          { paths: ctx.harnessState.paths, admin: admin() },
          input,
          method === 'DELETE',
        );
        changed();
        const choice = recent();
        if (choice.provider === input.id && !catalog.resolve(choice))
          await waitFor(
            ctx.get('harnessModelPreference')?.remember({ provider: '', id: '' }) ?? Promise.resolve(),
            signal,
          );
        return result;
      });
    });
  }
  for (const method of ['POST', 'DELETE']) {
    add(method, '/api/credentials', async ({ body, signal }) => {
      const input = await body();
      return write(async () => {
        signal.throwIfAborted();
        if (typeof input?.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider))
          throw new DomainError('invalid_input', 'Invalid provider');
        const store = admin();
        if (!store.hasProvider(input.provider)) throw new DomainError('invalid_input', 'Unknown provider');
        if (method === 'DELETE') {
          await store.removeCredential(input.provider);
        } else {
          if (typeof input.key !== 'string' || !input.key.trim())
            throw new DomainError('invalid_input', 'Invalid credential');
          await store.storeCredential(input.provider, input.key.trim());
        }
        changed();
        return {
          ok: true,
          persisted: true,
          models: catalog.list(),
          status: store.authStatus(input.provider),
        };
      });
    });
  }
  add('GET', '/api/models', async () => ({
    models: await catalog.available(),
    recent: recent(),
    canManageProviders: Boolean(providerAdministration()),
  }));
}
