import { HttpError } from '@mini-harness/contracts/routes';
import type { PluginApi } from '@mini-harness/contracts/plugins';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
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
  const changed = () => ctx.harnessChanges.dispatchEvent(new CustomEvent('change', { detail: { domain: 'models' } }));
  add('GET', '/api/providers', () => providerSettings(host));
  add('PUT', '/api/providers', async ({ body }) => ctx.harnessMutations.run(async () => {
    const input = await body();
    const release = ctx.harnessMutations.protect();
    try { const result = await saveProvider(host, input); changed(); return result; }
    finally { release(); }
  }));
  add('DELETE', '/api/providers', async ({ body }) => ctx.harnessMutations.run(async () => {
    const input = await body();
    const release = ctx.harnessMutations.protect();
    try { const result = await saveProvider(host, input, true); changed(); return result; }
    finally { release(); }
  }));
  for (const method of ['POST', 'DELETE']) {
    add(method, '/api/credentials', async ({ body }) => ctx.harnessMutations.run(async () => {
      const input = await body();
      if (typeof input?.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider))
        throw new HttpError('invalid_input', 'Invalid provider');
      if (!host.admin.hasProvider(input.provider)) throw new HttpError('invalid_input', 'Unknown provider');
      if (method === 'DELETE') {
        const release = ctx.harnessMutations.protect();
        try { await host.admin.removeCredential(input.provider); }
        finally { release(); }
      } else {
        if (typeof input.key !== 'string' || !input.key.trim()) throw new HttpError('invalid_input', 'Invalid credential');
        await host.admin.storeCredential(input.provider, input.key.trim());
      }
      changed();
      return { ok: true, persisted: true, models: host.catalog.list(),
        status: host.admin.authStatus(input.provider) };
    }));
  }
  add('GET', '/api/models', async () => ({ models: await host.catalog.available() }));
}
