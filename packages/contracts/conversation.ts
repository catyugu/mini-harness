import type { RunInfo } from './transport.js';

export interface ModelChoice { provider: string; id: string }

export interface SessionRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  titleSource: 'auto' | 'manual';
  createdAt: string;
}

export interface Conversation extends SessionRecord {
  updatedAt: string;
  waitingApproval?: boolean;
  model?: ModelChoice;
  run?: RunInfo;
}

export interface SessionSearchResult {
  id: string;
  field: 'title' | 'message';
  snippet: string;
  match: [start: number, end: number];
}
