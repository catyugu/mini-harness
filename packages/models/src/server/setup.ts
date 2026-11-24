import type {} from '@mini-harness/platform/runtime-paths';
import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/kernel/mutation-api';
import { DomainError } from '@mini-harness/platform/errors';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Context } from 'cordis';
import { providerSettings, saveProvider } from './provider-settings.js';

/** Provider discovery, credentials and model selection have one capability owner. */
export function setup(ctx: Context, api: PluginApi) {
  const recent = () => api.configuration.get<ModelChoice>('model');
  const remember = (model: ModelChoice) => api.configuration.set('model', model);
  ctx.provide('harnessModelPreference', {
    recent,
    remember: async (model) => {
      // Scoped-only models must not become an unusable application default.
      if (ctx.harnessModels.resolve(model)) await remember(model);
    }
  });
  const host = {
    paths: ctx.harnessState.paths,
    recent, remember,
    catalog: ctx.harnessModels,
    admin: ctx.harnessModelStore
  };
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('models'));
  const changed = () => changes.invalidate('models');
  add('GET', '/api/providers', () => providerSettings(host));
  for (const method of ['PUT', 'DELETE']) {
    add(method, '/api/providers', async ({ body }) => {
      const input = await body();
      return ctx.harnessMutations.run(async () => {
        const release = ctx.harnessMutations.protect();
        try { const result = await saveProvider(host, input, method === 'DELETE'); changed(); return result; }
        finally { release(); }
      });
    });
  }
  for (const method of ['POST', 'DELETE']) {
    add(method, '/api/credentials', async ({ body }) => {
      const input = await body();
      return ctx.harnessMutations.run(async () => {
        if (typeof input?.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider))
          throw new DomainError('invalid_input', 'Invalid provider');
        if (!host.admin.hasProvider(input.provider)) throw new DomainError('invalid_input', 'Unknown provider');
        if (method === 'DELETE') {
          const release = ctx.harnessMutations.protect();
          try { await host.admin.removeCredential(input.provider); }
          finally { release(); }
        } else {
          if (typeof input.key !== 'string' || !input.key.trim()) throw new DomainError('invalid_input', 'Invalid credential');
          await host.admin.storeCredential(input.provider, input.key.trim());
        }
        changed();
        return { ok: true, persisted: true, models: host.catalog.list(),
          status: host.admin.authStatus(input.provider) };
      });
    });
  }
  add('GET', '/api/models', async () => ({ models: await host.catalog.available() }));
}
