import type {} from '@mini-harness/plugin-api/profile';
import type { Context } from 'mini-harness/cordis';
import { MutationGate } from './mutations.js';
import { ProjectionChanges } from './projections.js';
import { RouteRegistry } from './router.js';
import { Upgrades } from './upgrade.js';

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

declare module 'mini-harness/cordis' {
  interface Context {
    harnessUpgrades: Pick<Upgrades, 'register' | 'dispatch' | 'close'>;
  }
}
