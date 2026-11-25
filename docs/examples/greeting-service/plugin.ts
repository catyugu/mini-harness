import type { Context } from 'mini-harness/cordis';

export interface Greeting {
  greet(name: string): string;
}

declare module 'mini-harness/cordis' {
  interface Context {
    exampleGreeting: Greeting;
    exampleSuffix?: string;
  }
}

export const provide = ['exampleGreeting'];
export function apply(ctx: Context, config: { prefix: string }) {
  ctx.provide('exampleGreeting', { greet: (name: string) => config.prefix + ', ' + name });
}
