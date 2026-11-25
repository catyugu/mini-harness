import type { Context } from 'mini-harness/cordis';
import { MutationGate } from './mutations.ts';
import { ProjectionChanges } from './projections.ts';
import { RouteRegistry } from './router.ts';
import { Upgrades } from './upgrade.ts';

export default {
  provide: ['harnessMutations', 'harnessChanges'],
  apply(ctx: Context) {
    const mutations = new MutationGate();
    ctx.provide('harnessMutations', mutations);
    ctx.provide('harnessChanges', new ProjectionChanges());
    ctx.on('harness/seal', () => mutations.seal());
    ctx.on('harness/drain', async () => {
      await mutations.drain();
    });
  },
};

export const http = {
  provide: ['harnessRoutes', 'harnessUpgrades'],
  apply(ctx: Context) {
    const routes = new RouteRegistry();
    const upgrades = new Upgrades();
    ctx.provide('harnessRoutes', routes);
    ctx.provide('harnessUpgrades', upgrades);
    ctx.on('harness/seal', () => {
      routes.seal();
      upgrades.close();
    });
    ctx.on('harness/drain', () => routes.drain());
  },
};

