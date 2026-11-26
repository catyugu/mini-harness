import type { Conversation, ConversationView } from '../shared/api.ts';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { ToolProgress } from '@mini-harness/runs/stream';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment } from '@mini-harness/input/message';
import type { HistoryEntry } from '@mini-harness/sessions/message';
import type { RunInfo } from '@mini-harness/sessions/run-state';

export interface ConversationRevision {
  sourceEntryId: string;
  expectedLeafId: string | null;
}

export interface RetryInput {
  message: string;
  attachments: Attachment[];
  missing: string[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel;
}

export interface ConversationSubmission {
  message: string;
  attachments?: Attachment[];
  model?: ModelChoice;
  thinkingLevel?: ThinkingLevel | null;
  permission?: ConversationPermission;
  revision?: ConversationRevision & { removedImages: number[] };
}

export interface ConversationState {
  session?: Omit<Conversation, 'run'> & { thinkingLevel?: ThinkingLevel };
  history?: {
    readonly timeline: readonly HistoryEntry[];
    leafId: string | null;
  };
  run?: RunInfo;
  partial: string;
  tools: readonly ToolProgress[];
  queue: readonly ConversationView['queue'][number][];
  interaction: {
    operation?: 'open' | 'submit' | 'queue' | 'compact';
    cancelling?: boolean;
    status: string;
    error?: boolean;
  };
}

export interface ConversationController {
  get(): Readonly<ConversationState>;
  subscribe(parts: readonly (keyof ConversationState)[], listener: () => void, signal: AbortSignal): void;
  activate(id: string, revealWorkspace?: boolean): Promise<boolean>;
  clear(): void;
  report(error: Error): void;
  submit(input: ConversationSubmission, created?: (sessionId: string) => void): Promise<RunInfo>;
  retryInput(): Promise<RetryInput | null>;
  queue(
    input: Omit<ConversationSubmission, 'revision' | 'permission'>,
    mode?: 'steer' | 'followUp',
  ): Promise<void>;
  cancel(): Promise<void>;
  cancelQueue(id?: string): Promise<void>;
  setPermission(permission: ConversationPermission): Promise<void>;
  compact(): Promise<void>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniConversation: ConversationController;
  }
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
