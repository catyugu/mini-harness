export default function setup(ctx, api) {
  ctx.provide('exampleGreeting', { greet: (name) => api.config.prefix + ', ' + name });
}
