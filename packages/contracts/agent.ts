import type { SessionRecord, ModelChoice } from './conversation.js';
import type { ImageInput, PreparedMessage } from './input.js';
import type { StreamEvent } from './transport.js';
import type { ViewMessage } from './message.js';

/** Pi session capabilities consumed by scheduling services; the adapter implements this port. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface RunAgentPort {
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): Promise<void>;
  prompt(record: SessionRecord, prompt: string, emit: (event: StreamEvent) => void, options: {
    signal: AbortSignal; choice?: ModelChoice; images?: ImageInput[]; input?: PreparedMessage;
    thinkingLevel?: ThinkingLevel; changed?: (path: string) => void;
    revision?: { sourceEntryId: string; expectedLeafId: string | null };
  }): Promise<string>;
  messages(id: string): ViewMessage[];
  compact(id: string, signal: AbortSignal): Promise<void>;
}
