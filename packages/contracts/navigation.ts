import type { Conversation } from './conversation.js';
import type { WorkspaceRecord } from './workspace.js';

export type NavigationEvent =
  | { type: 'snapshot'; workspaces: WorkspaceRecord[]; sessions: Conversation[] }
  | { type: 'workspaces'; workspaces: WorkspaceRecord[] }
  | { type: 'session'; session: Conversation }
  | { type: 'delete'; id: string };
