import type { Context } from 'mini-harness/cordis';
import type { NativeAssistantMessage, NativeMessage } from '@mini-harness/llm/api';
import type { ModelRequestContent } from './events.ts';
import type { InboxItem } from '@mini-harness/sessions/log-api';
import type { QueueEntry } from '@mini-harness/sessions/queue';
import type { SessionRecord } from '@mini-harness/sessions/identity';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment, ImageInput, InputSource, PreparedMessage } from '@mini-harness/input/message';
import type { AgentEvent } from './stream.ts';

export interface RevisionTarget {
  parentId: string | null;
  images: Attachment[];
  textFiles: string[];
}

export interface AgentPort {
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): RevisionTarget;
  prompt(
    ctx: Context,
    record: SessionRecord,
    prompt: string,
    emit: (event: AgentEvent) => void | Promise<void>,
    options: {
      signal: AbortSignal;
      source?: InputSource;
      submissionId?: string;
      choice?: ModelChoice;
      images?: ImageInput[];
      input?: PreparedMessage;
      fallback?: ModelChoice;
      beginSubmission?(): void;
      thinkingLevel?: ThinkingLevel | null;
      changed?: (path: string) => void;
      revision?: { parentId: string | null; expectedLeafId: string | null };
    },
  ): Promise<string>;
  compact(ctx: Context, id: string, signal: AbortSignal): Promise<void>;
  queueInput(
    ctx: Context,
    id: string,
    text: string,
    mode: 'steer' | 'followUp',
    attachments?: Attachment[],
    options?: Pick<InboxItem, 'model' | 'thinkingLevel'> & { fallback?: ModelChoice },
  ): QueueEntry[];
  cancelQueue(id: string, itemId?: string): QueueEntry[];
}

/** A scheduling strategy only receives call identities, not raw tool implementations. */
export interface ToolDispatch {
  readonly id: string;
  readonly name: string;
  readonly parallel: boolean;
}

export interface ToolExecutorPort {
  schedule(
    calls: readonly ToolDispatch[],
    signal: AbortSignal,
    execute: (id: string, signal: AbortSignal) => Promise<void>,
  ): Promise<void>;
}

export interface CompactionInput {
  messages: NativeMessage[];
  entryIds: string[];
  userEntryIds: string[];
  automatic: boolean;
  signal: AbortSignal;
  request(content: ModelRequestContent): Promise<NativeAssistantMessage>;
}

export interface CompactionResult {
  summary: string;
  keepFromId: string;
  tokensBefore?: number;
}

export interface CompactionPort {
  shouldCompact(messages: NativeMessage[], budget: number): boolean;
  compact(input: CompactionInput): Promise<CompactionResult | undefined>;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessAgent: AgentPort;
    harnessToolExecutor: ToolExecutorPort;
    harnessCompaction: CompactionPort;
  }
}
