export default function setup(ctx, api) {
  const greeting = ctx.exampleGreeting;
  api.registerRoute('GET', '/hello', ({ url }) => ({
    greeting: greeting.greet(url.searchParams.get('name') ?? 'world') + (ctx.get('exampleSuffix') ?? '')
  }));
}
