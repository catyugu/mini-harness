export const provide = ['exampleGreeting'];
export function apply(ctx, config) {
  ctx.provide('exampleGreeting', { greet: (name) => config.prefix + ', ' + name });
}
