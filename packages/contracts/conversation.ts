import type {} from 'cordis';
import type { ThinkingLevel } from './agent.js';
import type { ViewMessage } from './message.js';
import type { QueueEntry } from './session-log.js';
import type { StreamEvent } from './transport.js';
import type { RunInfo } from './transport.js';

export interface ModelChoice { provider: string; id: string }
export type ConversationPermission = 'standard' | 'readOnly' | 'fullAccess';

export interface SessionRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  titleSource: 'auto' | 'manual';
  createdAt: string;
  permission?: ConversationPermission;
}

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
