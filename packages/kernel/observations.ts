import type {} from 'cordis';

export interface CapabilityObservations {}
export type CapabilityObservation = CapabilityObservations[keyof CapabilityObservations];

declare module 'cordis' {
  interface Events {
    'harness/observe'(event: CapabilityObservation, signal?: AbortSignal): void;
  }
}
