import type { Conversation, ConversationView } from '../shared/api.ts';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { MessageMode } from '@mini-harness/sessions/queue';
import type { SendReceipt } from '@mini-harness/runs/api';
import type { ToolProgress } from '@mini-harness/runs/stream';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment } from '@mini-harness/input/message';
import type { HistoryEntry } from '@mini-harness/sessions/message';
import type { LiveRecord } from '@mini-harness/runs/stream';
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
  records: readonly LiveRecord[];
  mode: MessageMode;
  queue: readonly ConversationView['queue'][number][];
  interaction: {
    operation?: 'open' | 'submit';
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
  report(message: string | Error): void;
  submit(
    input: ConversationSubmission,
    created?: (sessionId: string) => void,
  ): Promise<Pick<SendReceipt, 'run' | 'messageId'> | { run: RunInfo }>;
  chooseMode(mode: MessageMode): void;
  retryInput(): Promise<RetryInput | null>;
  cancel(): Promise<void>;
  cancelQueue(id?: string): Promise<void>;
  setPermission(permission: ConversationPermission): Promise<void>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    miniConversation: ConversationController;
  }
  interface Events {
    'conversation/initialize'(workspaceId: string, sessionId: string): void | Promise<void>;
  }
}

declare module '@mini-harness/ui-slots/browser/api' {
  interface SlotMap {
    'workspace.welcome': { kind: 'single' };
    'conversation.composer': { kind: 'list' };
    'conversation.composer-options': { kind: 'list' };
    'conversation.composer-trailing': { kind: 'list' };
    'conversation.composer-footer': { kind: 'list' };
    'conversation.composer-view': { kind: 'single' };
    'conversation.history': { kind: 'single' };
    'conversation.approvals': { kind: 'list' };
  }
}
