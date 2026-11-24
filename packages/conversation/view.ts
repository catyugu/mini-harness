import type {} from 'cordis';
import type { ThinkingLevel, ModelChoice } from '@mini-harness/llm/vocabulary';
import type { ViewMessage } from '@mini-harness/sessions/message';
import type { QueueEntry } from '@mini-harness/sessions/log-api';
import type { StreamEvent } from '@mini-harness/runs/stream';
import type { RunInfo } from '@mini-harness/sessions/run-state.browser';
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
  leafId: string | null;
  model: ModelChoice;
  thinkingLevel?: ThinkingLevel;
  partial?: string;
  tools: Extract<StreamEvent, { type: 'tool' }>[];
  queue: QueueEntry[];
}

export interface ConversationViewPort {
  read(id: string): ConversationView;
}

declare module 'cordis' {
  interface Context { harnessConversationView: ConversationViewPort }
}
