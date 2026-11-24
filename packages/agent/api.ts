import type {} from 'cordis';
import type { InboxItem, QueueEntry } from '@mini-harness/sessions/log-api';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment, ImageInput, InputSource, PreparedMessage } from '@mini-harness/input/message';
import type { AgentEvent } from './stream.js';
import type { ViewMessage } from '@mini-harness/sessions/message';

export interface RevisionTarget {
  parentId: string | null;
  images: Attachment[];
  textFiles: string[];
}

export interface AgentPort {
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): Promise<RevisionTarget>;
  prompt(record: SessionRecord, prompt: string, emit: (event: AgentEvent) => void, options: {
    signal: AbortSignal; source?: InputSource; submissionId?: string; choice?: ModelChoice; images?: ImageInput[]; input?: PreparedMessage;
    thinkingLevel?: ThinkingLevel | null; changed?: (path: string) => void;
    revision?: { sourceEntryId: string; expectedLeafId: string | null };
  }): Promise<string>;
  messages(id: string): ViewMessage[];
  compact(id: string, signal: AbortSignal): Promise<void>;
  readonly hasPending: boolean;
  prepare(id: string, signal?: AbortSignal): Promise<void>;
  activeModel(id: string): ModelChoice;
  read(id: string): {
    messages: ViewMessage[];
    leafId: string | null;
    model: ModelChoice;
    thinkingLevel?: ThinkingLevel;
    queue: QueueEntry[];
  };
  queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[],
    options?: Pick<InboxItem, 'model' | 'thinkingLevel'>): Promise<QueueEntry[]>;
  queue(id: string): QueueEntry[];
  cancelQueue(id: string, itemId?: string): QueueEntry[];
}

declare module 'cordis' {
  interface Context { harnessAgent: AgentPort }
}
