import type {} from 'cordis';
import type { Conversation } from '../../shared/api.js';
import type { WorkspaceRecord } from '@mini-harness/workspaces/record';

export interface ConversationSessions {
  get(): Conversation[];
  refresh(): Promise<void>;
  subscribe(listener: () => void, signal: AbortSignal): void;
}

export interface ConversationSelection extends EventTarget {
  readonly selectedWorkspace: string | undefined;
  readonly activeConversation: string | undefined;
  selectWorkspace(id?: string): void;
  selectConversation(item?: Conversation, revealWorkspace?: boolean): void;
  initialConversation(sessions: Conversation[], workspaces: WorkspaceRecord[]): Conversation | undefined;
  scope(): { workspaceId: string; sessionId?: string } | undefined;
  changed(): void;
  subscribe(listener: () => void, signal: AbortSignal): void;
}

declare module 'cordis' {
  interface Context {
    miniSessions: ConversationSessions;
    miniSelection: ConversationSelection;
  }
}
