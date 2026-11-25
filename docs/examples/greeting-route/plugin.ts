import type { Context } from 'mini-harness/cordis';
import type { PluginRoutes } from 'mini-harness/transport';
import type { Greeting } from '../greeting-service/plugin.ts';

export const inject = ['exampleGreeting', 'harnessPluginRoutes'];
export function apply(ctx: Context) {
  const greeting: Greeting = ctx.exampleGreeting;
  const routes: PluginRoutes = ctx.harnessPluginRoutes;
  routes.register('GET', '/hello', ({ url }) => ({
    greeting: greeting.greet(url.searchParams.get('name') ?? 'world') + (ctx.get('exampleSuffix') ?? ''),
  }));
}
