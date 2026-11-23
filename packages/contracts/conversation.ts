import type { RunInfo } from './transport.js';

export interface ModelChoice { provider: string; id: string }
export type ConversationPermission = 'standard' | 'readOnly';

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
