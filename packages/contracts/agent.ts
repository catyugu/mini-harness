import type { SessionRecord, ModelChoice } from './conversation.js';
import type { Attachment, ImageInput, InputSource, PreparedMessage } from './input.js';
import type { StreamEvent } from './transport.js';
import type { PromptContext } from './extensions.js';
import type { ViewMessage } from './message.js';

/** Native execution capabilities consumed by scheduling services. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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

export interface RunAgentPort {
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): Promise<RevisionTarget>;
  prompt(record: SessionRecord, prompt: string, emit: (event: StreamEvent) => void, options: {
    signal: AbortSignal; source?: InputSource; submissionId?: string; choice?: ModelChoice; images?: ImageInput[]; input?: PreparedMessage;
    thinkingLevel?: ThinkingLevel | null; changed?: (path: string) => void;
    revision?: { sourceEntryId: string; expectedLeafId: string | null };
  }): Promise<string>;
  messages(id: string): ViewMessage[];
  compact(id: string, signal: AbortSignal): Promise<void>;
}
