import type {} from 'cordis';

export interface CapabilityObservations {}
export type CapabilityObservation = CapabilityObservations[keyof CapabilityObservations];

declare module 'cordis' {
  interface Events {
    /** Application graph is mounted; complete startup before admitting requests. */
    'harness/startup'(pending: Promise<void>[]): void;
    /** Stop admission synchronously and register outstanding resource work to drain. */
    'harness/quiesce'(pending: Promise<void>[]): void;
    'harness/status'(status: Record<string, unknown>): void;
    'harness/observe'(event: CapabilityObservation, signal?: AbortSignal): void;
  }
}
