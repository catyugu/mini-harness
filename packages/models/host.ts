import type { Context } from 'cordis';
import { providerSettings, saveProvider, saveProviderCredential } from './provider-settings.js';

/** Provider discovery, credentials and Pi model selection have one capability owner. */
export function setup(ctx: Context) {
  const host = {
    paths: ctx.harnessState.paths,
    get settings() { return ctx.harnessSettings(); },
    pi: ctx.harnessPi,
    get delegation() { return ctx.get('harnessDelegation'); },
    get hasActiveWork() { return ctx.harnessOperations.hasActiveWork; },
    updateSettings: (patch: Parameters<typeof ctx.harnessUpdateSettings>[0]) => ctx.harnessUpdateSettings(patch)
  };
  ctx.provide('harnessProviderCatalog', () => providerSettings(host));
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  add('GET', '/api/providers', () => providerSettings(host));
  add('PUT', '/api/providers', async ({ body }) => ctx.harnessMutations.run(async () =>
    saveProvider(host, await body())));
  add('DELETE', '/api/providers', async ({ body }) => ctx.harnessMutations.run(async () =>
    saveProvider(host, await body(), true)));
  for (const method of ['POST', 'DELETE']) {
    add(method, '/api/credentials', async ({ body }) => ctx.harnessMutations.run(async () => {
      const input = await body();
      if (typeof input?.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider))
        throw new Error('Invalid provider');
      if (!ctx.harnessPi.models.getProvider(input.provider)) throw new Error('Unknown provider');
      if (method === 'DELETE') {
        if (ctx.harnessOperations.hasActiveWork) throw new Error('Stop active conversations before removing credentials');
        await ctx.harnessPi.models.logout(input.provider);
      } else {
        if (typeof input.key !== 'string' || !input.key.trim()) throw new Error('Invalid credential');
        await saveProviderCredential(host, input.provider, input.key.trim());
      }
      return { ok: true, persisted: true, models: ctx.harnessPi.availableModels(),
        status: ctx.harnessPi.models.getProviderAuthStatus(input.provider) };
    }));
  }
  add('GET', '/api/models', async () => {
    await ctx.harnessPi.models.getAvailable();
    return { models: ctx.harnessPi.availableModels() };
  });
}
