import type { SessionProjection } from '@mini-harness/sessions/log-api';
import type { AgentEvent } from '@mini-harness/agent/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export type StreamEvent = AgentEvent
  | { type: 'run'; run: RunInfo }
  | ({ type: 'snapshot'; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[]; run: RunInfo }
    & Pick<SessionProjection, 'messages' | 'records' | 'model' | 'thinkingLevel' | 'leafId'>);

export type RunEvent = StreamEvent & { runId: string; runSessionId: string; sequence: number };
