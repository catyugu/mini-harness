import type { Context } from 'mini-harness/cordis';
import { scopeOf, scopeTarget, type ScopeKey } from './scopes.ts';

export interface CapabilityObservations {}
export type CapabilityObservation = CapabilityObservations[keyof CapabilityObservations];

declare module 'mini-harness/cordis' {
  interface Events {
    'harness/observe'(event: CapabilityObservation, signal: AbortSignal): void | Promise<void>;
  }
}

export function observe(
  ctx: Context,
  event: CapabilityObservation,
  request?: AbortSignal,
  scope: ScopeKey | undefined = scopeOf(ctx),
) {
  for (const { context, callback } of ctx.events.listeners('harness/observe', scopeTarget(ctx, scope))) {
    void context.fiber
      .run((signal) => callback(structuredClone(event), signal), request)
      .catch((error) => {
        if (!context.fiber.signal.aborted && !request?.aborted) context.logger.warn(String(error));
      });
  }
}
