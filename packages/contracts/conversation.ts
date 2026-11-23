import type { RunInfo } from './transport.js';

export interface ModelChoice { provider: string; id: string }

export interface SessionRecord {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  titleSource: 'auto' | 'manual';
  createdAt: string;
  piSessionRef: string | null;
}

export interface Conversation extends Omit<SessionRecord, 'piSessionRef'> {
  updatedAt: string;
  waitingApproval?: boolean;
  model?: ModelChoice;
  run?: RunInfo;
}
