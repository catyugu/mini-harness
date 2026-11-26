import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { ViewMessage } from '@mini-harness/sessions/message';
import type { QueueEntry } from '@mini-harness/sessions/queue';
import type { StreamEvent } from '@mini-harness/runs/stream';
import type { RunInfo, RunTermination } from '@mini-harness/sessions/run-state';
import type { SessionRecord } from '@mini-harness/sessions/identity';

export interface Conversation extends SessionRecord {
  updatedAt: string;
  waitingApproval?: boolean;
  model?: ModelChoice;
  run?: RunInfo;
  logError?: string;
}

export interface SessionSearchResult {
  id: string;
  field: 'title' | 'message';
  snippet: string;
  match: [start: number, end: number];
}

export interface ConversationView extends Conversation {
  messages: ViewMessage[];
  records: SessionDisplayRecord[];
  terminations: RunTermination[];
  leafId: string | null;
  thinkingLevel?: ThinkingLevel;
  partial?: string;
  tools: Extract<StreamEvent, { type: 'tool' }>[];
  queue: QueueEntry[];
}
