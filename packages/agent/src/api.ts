import type {} from 'cordis';
import type { InboxItem } from '@mini-harness/sessions/log-api';
import type { QueueEntry } from '@mini-harness/sessions/queue';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment, ImageInput, InputSource, PreparedMessage } from '@mini-harness/input/message';
import type { AgentEvent } from './stream.js';

export interface RevisionTarget {
  parentId: string | null;
  images: Attachment[];
  textFiles: string[];
}

export interface AgentPort {
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): RevisionTarget;
  prompt(record: SessionRecord, prompt: string, emit: (event: AgentEvent) => void | Promise<void>, options: {
    signal: AbortSignal; source?: InputSource; submissionId?: string; choice?: ModelChoice; images?: ImageInput[]; input?: PreparedMessage;
    fallback?: ModelChoice;
    thinkingLevel?: ThinkingLevel | null; changed?: (path: string) => void;
    revision?: { sourceEntryId: string; expectedLeafId: string | null };
  }): Promise<string>;
  compact(id: string, signal: AbortSignal): Promise<void>;
  queueInput(id: string, text: string, mode: 'steer' | 'followUp', attachments?: Attachment[],
    options?: Pick<InboxItem, 'model' | 'thinkingLevel'> & { fallback?: ModelChoice }): QueueEntry[];
  cancelQueue(id: string, itemId?: string): QueueEntry[];
}

declare module 'cordis' {
  interface Context { harnessAgent: AgentPort }
}
