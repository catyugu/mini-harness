import type {} from 'cordis';
import type { RunInfo } from './transport.js';
import type { MessageContent } from './message.js';

export type CapabilityObservation =
  | { type: 'session-created'; sessionId: string }
  | { type: 'session-deleted'; sessionId: string; scopeKeys: readonly string[] }
  | { type: 'run-started' | 'run-ended'; sessionId: string; run: RunInfo }
  | { type: 'step-started'; sessionId: string; turn: number }
  | { type: 'model-attempt-ended'; sessionId: string; attempt: number; failed: boolean }
  | { type: 'tool-ended'; sessionId: string; tool: string; callId: string; failed: boolean; elapsedMs?: number };

export interface ToolDecision {
  sessionId: string;
  tool: string;
  callId: string;
  arguments: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface ToolProjection {
  sessionId: string;
  tool: string;
  content: MessageContent;
}

declare module 'cordis' {
  interface Events {
    'harness/observe'(event: CapabilityObservation): void;
  }
}
