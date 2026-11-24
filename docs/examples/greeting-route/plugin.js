export const inject = ["exampleGreeting", "harnessPluginRoutes"];
export function apply(ctx) {
  const greeting = ctx.exampleGreeting;
  ctx.harnessPluginRoutes.register('GET', '/hello', ({ url }) => ({
    greeting: greeting.greet(url.searchParams.get('name') ?? 'world') + (ctx.get('exampleSuffix') ?? '')
  }));
}
