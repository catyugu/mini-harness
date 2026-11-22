import type { RunInfo } from './transport.js';

export interface ModelChoice { provider: string; id: string }
export interface Conversation {
  id: string;
  title: string;
  cwd: string;
  workspaceId: string;
  waitingApproval?: boolean;
  parentId: string | null;
  file: string | null;
  model?: ModelChoice;
  run?: RunInfo;
  createdAt: string;
  updatedAt: string;
}
