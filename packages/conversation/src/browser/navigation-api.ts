import type {} from 'cordis';
import type { WorkspaceRecord } from '@mini-harness/workspaces/record';
import type { Conversation } from '../shared/api.js';

export interface ConversationBrowserPort {
  workspaceRecord(id: string): WorkspaceRecord | undefined;
  openConversation(id: string): void;
  workspace(): { workspaceId: string; sessionId?: string } | undefined;
  session(id?: string): Conversation | undefined;
  onConversationChange(listener: () => void, signal: AbortSignal): void;
  report(error: Error): void;
}

declare module 'cordis' {
  interface Context { harnessBrowser: ConversationBrowserPort }
}
