import type { Context } from 'mini-harness/cordis';
import { ProjectionChanges } from './projections.ts';
import { RouteRegistry } from './router.ts';
import { Upgrades } from './upgrade.ts';

export default {
  provide: ['harnessChanges'],
  apply(ctx: Context) {
    ctx.provide('harnessChanges', new ProjectionChanges());
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

export const metadata = { title: 'Transport' };
export const httpMetadata = { title: 'HTTP Routing' };
