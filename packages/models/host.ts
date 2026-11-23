import type { Context } from 'cordis';
import { providerSettings, saveProvider } from './provider-settings.js';

/** Provider discovery, credentials and model selection have one capability owner. */
export function setup(ctx: Context) {
  const host = {
    paths: ctx.harnessState.paths,
    get settings() { return ctx.harnessSettings(); },
    catalog: ctx.harnessModels,
    admin: ctx.harnessModelAdmin,
    get delegation() { return ctx.get('harnessDelegation'); },
    get hasActiveWork() { return (ctx.harnessRuns.size > 0 || ctx.harnessAgent.hasPending); },
    updateSettings: (patch: Parameters<typeof ctx.harnessUpdateSettings>[0]) => ctx.harnessUpdateSettings(patch)
  };
  ctx.effect(() => ctx.harnessSettingsStore.validate((next) => { host.catalog.resolve(next.model); }));
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
      if (!host.admin.hasProvider(input.provider)) throw new Error('Unknown provider');
      if (method === 'DELETE') {
        if ((ctx.harnessRuns.size > 0 || ctx.harnessAgent.hasPending)) throw new Error('Stop active conversations before removing credentials');
        await host.admin.removeCredential(input.provider);
      } else {
        if (typeof input.key !== 'string' || !input.key.trim()) throw new Error('Invalid credential');
        await host.admin.storeCredential(input.provider, input.key.trim());
      }
      changed();
      return { ok: true, persisted: true, models: host.catalog.list(),
        status: host.admin.authStatus(input.provider) };
    }));
  }
  add('GET', '/api/models', async () => ({ models: await host.catalog.available() }));
}
