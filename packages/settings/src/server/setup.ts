import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/kernel/mutation-api';
import type {} from '@mini-harness/transport/routes';
import type { Context } from 'cordis';

export function setup(ctx: Context) {
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('settings'));
  ctx.effect(() => ctx.harnessSettingsStore.subscribe(() => changes.invalidate('settings')));
  const { harnessSettingsStore: store, harnessMutations: mutations, harnessRoutes: routes } = ctx;
  ctx.effect(() => routes.register('GET', '/api/settings', () => store.settings));
  ctx.effect(() => routes.register('PATCH', '/api/settings', async ({ body }) => {
    const patch = await body();
    return mutations.run(() => store.update(patch));
  }));
}
