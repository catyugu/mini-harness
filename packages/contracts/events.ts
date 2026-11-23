import type {} from 'cordis';
import type { RunInfo } from './transport.js';
import type { MessageContent } from './message.js';

export type CapabilityObservation =
  | { type: 'session-created'; sessionId: string }
  | { type: 'session-deleted'; sessionId: string; scopeKeys: readonly string[] }
  | { type: 'run-started' | 'run-ended'; sessionId: string; run: RunInfo }
  | { type: 'tool-ended'; sessionId: string; tool: string; failed: boolean };

export interface ToolDecision {
  sessionId: string;
  tool: string;
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
    'harness/tool-decision'(request: ToolDecision): 'deny' | undefined | Promise<'deny' | undefined>;
    'harness/tool-projection'(request: ToolProjection, next: () => MessageContent): MessageContent;
  }
}
