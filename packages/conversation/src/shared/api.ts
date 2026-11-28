import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { RunHistoryEntry } from '@mini-harness/runs/run-state';
import type { LiveRecord } from '@mini-harness/runs/stream';
import type { QueueEntry } from '@mini-harness/sessions/queue';
import type { ToolProgress } from '@mini-harness/runs/stream';
import type { RunInfo } from '@mini-harness/runs/run-state';
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
  timeline: RunHistoryEntry[];
  leafId: string | null;
  thinkingLevel?: ThinkingLevel;
  partial?: string;
  tools: ToolProgress[];
  records: LiveRecord[];
  queue: QueueEntry[];
}
