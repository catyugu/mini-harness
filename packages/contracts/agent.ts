import type {} from 'cordis';
import type { InboxItem, QueueEntry } from './session-log.js';
import type { SessionRecord, ModelChoice, ConversationView } from './conversation.js';
import type { Attachment, ImageInput, InputSource, PreparedMessage } from './input.js';
import type { StreamEvent } from './transport.js';
import type { PromptContext } from './prompt-extensions.js';
import type { ViewMessage } from './message.js';

/** Native execution capabilities consumed by scheduling services. */
const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof thinkingLevels[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return thinkingLevels.some((level) => level === value);
}

export interface PromptPort {
  build(request: PromptContext): Promise<string>;
}

declare module 'cordis' {
  interface Context { harnessPrompt: PromptPort }
}

export interface RevisionTarget {
  parentId: string | null;
  images: Attachment[];
  textFiles: string[];
}

export interface AgentPort {
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): Promise<RevisionTarget>;
  prompt(record: SessionRecord, prompt: string, emit: (event: StreamEvent) => void, options: {
    signal: AbortSignal; source?: InputSource; submissionId?: string; choice?: ModelChoice; images?: ImageInput[]; input?: PreparedMessage;
    thinkingLevel?: ThinkingLevel | null; changed?: (path: string) => void;
    revision?: { sourceEntryId: string; expectedLeafId: string | null };
  }): Promise<string>;
  messages(id: string): ViewMessage[];
  compact(id: string, signal: AbortSignal): Promise<void>;
  readonly hasPending: boolean;
  prepare(id: string, signal?: AbortSignal): Promise<void>;
  activeModel(id: string): ModelChoice;
  read(id: string): Pick<ConversationView, 'messages' | 'leafId' | 'model' | 'thinkingLevel' | 'queue'>;
  queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[],
    options?: Pick<InboxItem, 'model' | 'thinkingLevel'>): Promise<QueueEntry[]>;
  queue(id: string): QueueEntry[];
  cancelQueue(id: string, itemId?: string): QueueEntry[];
}

declare module 'cordis' {
  interface Context { harnessAgent: AgentPort }
}
