import type { Context } from 'cordis';

/** Settings API is one owner of configuration transactions, not a server branch. */
export function setup(ctx: Context) {
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/settings', () => ctx.harnessSettings()));
  ctx.effect(() => ctx.harnessRoutes.register('PATCH', '/api/settings',
    async ({ body }) => ctx.harnessMutations.run(async () => ctx.harnessUpdateSettings(await body()))));
}
