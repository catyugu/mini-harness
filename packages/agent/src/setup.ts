import type { Context } from 'mini-harness/cordis';
import { NativeAgent } from './agent.ts';

export function setup(ctx: Context) {
  ctx.provide(
    'harnessAgent',
    new NativeAgent(
      ctx.harnessRegistry,
      () => ctx.fiber.effectiveConfig as { maxTurns: number; autoCompact: boolean },
    ),
  );
}
