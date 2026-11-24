import type { Context } from 'mini-harness/cordis';
import { scopedEvent, sessionEvent } from './instance.js';

export interface CapabilityObservations {}
export type CapabilityObservation = CapabilityObservations[keyof CapabilityObservations];

declare module 'mini-harness/cordis' {
  interface Events {
    'harness/observe'(event: CapabilityObservation, signal: AbortSignal): void | Promise<void>;
  }
}

export function observe(ctx: Context, event: CapabilityObservation, request?: AbortSignal) {
  const scope = event.type === 'session-deleted' ? scopedEvent(ctx, event.scopeKeys) : sessionEvent(ctx, event.sessionId);
  for (const { context, callback } of ctx.events.listeners('harness/observe', scope)) {
    void context.fiber.run(signal => callback(structuredClone(event), signal), request).catch(error => {
      if (!context.fiber.signal.aborted && !request?.aborted) context.logger.warn(String(error));
    });
  }
}
