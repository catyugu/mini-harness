import type { Context } from 'mini-harness/cordis';
import type { RoutePort } from 'mini-harness/transport';
import type { Greeting } from '../greeting-service/plugin.ts';

export const inject = ['exampleGreeting', 'harnessRoutes'];
export function apply(ctx: Context) {
  const greeting: Greeting = ctx.exampleGreeting;
  const routes: RoutePort = ctx.harnessRoutes;
  ctx.effect(() =>
    routes.register('GET', '/api/greeting/hello/:name', ({ params }) => ({
      greeting: greeting.greet(params.name) + (ctx.get('exampleSuffix') ?? ''),
    })),
  );
}
