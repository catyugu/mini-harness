import { HttpError } from '@mini-harness/contracts/routes';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from 'cordis';
import { providerSettings, saveProvider } from './provider-settings.js';

/** Provider discovery, credentials and model selection have one capability owner. */
export function setup(ctx: Context) {
  const host = {
    paths: ctx.harnessState.paths,
    get settings() { return ctx.harnessSettings(); },
    catalog: ctx.harnessModels,
    admin: ctx.harnessModelAdmin,
    updateSettings: (patch: Parameters<typeof ctx.harnessUpdateSettings>[0]) => ctx.harnessUpdateSettings(patch)
  };
  ctx.effect(() => ctx.harnessSettingsStore.validate(({ model }, previous) => {
    if (!isDeepStrictEqual(model, previous.model) && (model.provider || model.id) && !host.catalog.resolve(model))
      throw new HttpError('invalid_input', 'Unknown model: ' + model.provider + '/' + model.id);
  }));
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
