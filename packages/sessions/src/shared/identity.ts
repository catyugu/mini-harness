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

declare module '@mini-harness/plugin-api/observations' {
  interface CapabilityObservations {
    'session-created': { type: 'session-created'; sessionId: string };
    'session-deleted': { type: 'session-deleted'; sessionId: string; scopeKeys: readonly string[] };
  }
}
