import type { Context } from 'mini-harness/cordis';
import type { RoutePort } from 'mini-harness/transport';
import type { Greeting } from '../greeting-service/plugin.ts';

export const inject = ['exampleGreeting', 'harnessRoutes'];
export function apply(ctx: Context) {
  const greeting: Greeting = ctx.exampleGreeting;
  const routes: RoutePort = ctx.harnessRoutes;
  routes.register('GET', '/api/extensions/greeting-route/hello', ({ url }) => ({
    greeting: greeting.greet(url.searchParams.get('name') ?? 'world') + (ctx.get('exampleSuffix') ?? ''),
  }));
}
