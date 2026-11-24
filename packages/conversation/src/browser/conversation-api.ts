import type {} from 'cordis';
import type { Conversation, ConversationView } from '../shared/api.js';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { StreamEvent } from '@mini-harness/runs/stream';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment } from '@mini-harness/input/message';
import type { ViewMessage } from '@mini-harness/sessions/message';
import type { RunInfo } from '@mini-harness/sessions/run-state';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { DraftMode } from './composer-api.js';

export interface ConversationSubmission {
  message: string;
  attachments?: Attachment[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel | null;
  permission?: ConversationPermission;
  revision?: DraftMode['revision'] & { removedImages: number[] };
}

export interface ConversationState {
  session?: Omit<Conversation, 'run'> & { thinkingLevel?: ThinkingLevel };
  history: { readonly messages: readonly ViewMessage[]; readonly records: readonly SessionDisplayRecord[]; leafId: string | null };
  run?: RunInfo;
  partial: string;
  tools: readonly Extract<StreamEvent, { type: 'tool' }>[];
  queue: readonly ConversationView['queue'][number][];
  interaction: { operation?: 'open' | 'submit' | 'queue' | 'compact'; cancelling?: boolean; status: string; error?: boolean };
}

export interface ConversationController {
  get(): Readonly<ConversationState>;
  subscribe(parts: readonly (keyof ConversationState)[], listener: () => void, signal: AbortSignal): void;
  activate(id: string, revealWorkspace?: boolean): Promise<boolean>;
  clear(): void;
  report(error: Error): void;
  submit(input: ConversationSubmission, created?: (sessionId: string) => void): Promise<RunInfo & { accepted: boolean }>;
  queue(input: Omit<ConversationSubmission, 'revision' | 'permission'>, mode?: 'steer' | 'followUp'): Promise<void>;
  cancel(): Promise<void>;
  cancelQueue(id?: string): Promise<void>;
  setPermission(permission: ConversationPermission): Promise<void>;
  compact(): Promise<void>;
}

declare module 'cordis' {
  interface Context { miniConversation: ConversationController }
}

declare module '@mini-harness/ui-slots/browser/api' {
  interface SlotMap {
    'workspace.welcome': { kind: 'single' };
    'conversation.composer': { kind: 'list' };
    'conversation.composer-view': { kind: 'single' };
    'conversation.history': { kind: 'single' };
    'conversation.approvals': { kind: 'list' };
  }
}
