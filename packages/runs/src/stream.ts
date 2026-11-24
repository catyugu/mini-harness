import type { ViewMessage } from '@mini-harness/sessions/message';
import type { AgentEvent } from '@mini-harness/agent/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export type StreamEvent = AgentEvent
  | { type: 'run'; run: RunInfo }
  | { type: 'snapshot'; messages: ViewMessage[]; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; run: RunInfo };

export type RunEvent = StreamEvent & { runId: string; runSessionId: string; sequence: number };
