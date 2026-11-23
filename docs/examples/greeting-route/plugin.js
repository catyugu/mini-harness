export default function setup(_ctx, api) {
  const greeting = api.service('exampleGreeting');
  api.registerRoute('GET', '/hello', ({ url }) => ({
    greeting: greeting.greet(url.searchParams.get('name') ?? 'world') + (api.optionalService('exampleSuffix') ?? '')
  }));
}
