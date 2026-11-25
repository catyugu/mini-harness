import { waitFor } from '@mini-harness/platform/wait';
import { DomainError } from '@mini-harness/platform/errors';
import type { Context } from 'mini-harness/cordis';
import { saveProvider } from './provider-settings.ts';

export function setupAdministration(ctx: Context) {
  const { recent, remember } = ctx.harnessModelPreference;
  const host = {
    paths: ctx.harnessState.paths,
    catalog: ctx.harnessModels,
    admin: ctx.harnessModelStore,
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
  add('GET', '/api/providers', () => host.admin.providers());
  for (const method of ['PUT', 'DELETE']) {
    add(method, '/api/providers', async ({ body, signal }) => {
      const input = await body();
      return write(async () => {
        signal.throwIfAborted();
        const result = await saveProvider(host, input, method === 'DELETE');
        changed();
        const choice = recent();
        if (choice.provider === input.id && !host.catalog.resolve(choice))
          await waitFor(remember({ provider: '', id: '' }), signal);
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
        if (!host.admin.hasProvider(input.provider))
          throw new DomainError('invalid_input', 'Unknown provider');
        if (method === 'DELETE') {
          await host.admin.removeCredential(input.provider);
        } else {
          if (typeof input.key !== 'string' || !input.key.trim())
            throw new DomainError('invalid_input', 'Invalid credential');
          await host.admin.storeCredential(input.provider, input.key.trim());
        }
        changed();
        return {
          ok: true,
          persisted: true,
          models: host.catalog.list(),
          status: host.admin.authStatus(input.provider),
        };
      });
    });
  }
  add('GET', '/api/models', async () => ({ models: await host.catalog.available(), recent: recent() }));
}
