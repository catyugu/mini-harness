import type { Context } from 'cordis';
import { providerSettings, saveProvider, saveProviderCredential } from './provider-settings.js';

/** Provider discovery, credentials and Pi model selection have one capability owner. */
export function setup(ctx: Context) {
  const host = {
    paths: ctx.harnessState.paths,
    get settings() { return ctx.harnessSettings(); },
    pi: ctx.harnessPi,
    get delegation() { return ctx.get('harnessDelegation'); },
    get hasActiveWork() { return (ctx.harnessRuns.size > 0 || ctx.harnessPi.hasPending); },
    updateSettings: (patch: Parameters<typeof ctx.harnessUpdateSettings>[0]) => ctx.harnessUpdateSettings(patch)
  };
  const add = (method: string, path: string, handler: Parameters<typeof ctx.harnessRoutes.register>[2]) =>
    ctx.effect(() => ctx.harnessRoutes.register(method, path, handler));
  const changed = () => ctx.harnessChanges.dispatchEvent(new CustomEvent('change', { detail: { domain: 'models' } }));
  add('GET', '/api/providers', () => providerSettings(host));
  add('PUT', '/api/providers', async ({ body }) => ctx.harnessMutations.run(async () => {
    const result = await saveProvider(host, await body());
    changed();
    return result;
  }));
  add('DELETE', '/api/providers', async ({ body }) => ctx.harnessMutations.run(async () => {
    const result = await saveProvider(host, await body(), true);
    changed();
    return result;
  }));
  for (const method of ['POST', 'DELETE']) {
    add(method, '/api/credentials', async ({ body }) => ctx.harnessMutations.run(async () => {
      const input = await body();
      if (typeof input?.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider))
        throw new Error('Invalid provider');
      if (!ctx.harnessPi.models.getProvider(input.provider)) throw new Error('Unknown provider');
      if (method === 'DELETE') {
        if ((ctx.harnessRuns.size > 0 || ctx.harnessPi.hasPending)) throw new Error('Stop active conversations before removing credentials');
        await ctx.harnessPi.models.logout(input.provider);
      } else {
        if (typeof input.key !== 'string' || !input.key.trim()) throw new Error('Invalid credential');
        await saveProviderCredential(host, input.provider, input.key.trim());
      }
      changed();
      return { ok: true, persisted: true, models: ctx.harnessPi.availableModels(),
        status: ctx.harnessPi.models.getProviderAuthStatus(input.provider) };
    }));
  }
  add('GET', '/api/models', async () => {
    await ctx.harnessPi.models.getAvailable();
    return { models: ctx.harnessPi.availableModels() };
  });
}
