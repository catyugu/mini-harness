import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { Conversation, ModelChoice } from './conversation.js';
import type { ImageInput } from './input.js';
import type { StreamEvent } from './transport.js';
import type { ViewMessage } from './message.js';

/** Pi session capabilities consumed by scheduling services; the adapter implements this port. */
export interface RunAgentPort {
  reopenStale(id: string): void;
  resolveModel(choice: ModelChoice): AgentSession['model'] | undefined;
  revisionTarget(id: string, sourceEntryId: string, expectedLeafId: string | null): Promise<unknown>;
  prompt(record: Conversation, prompt: string, emit: (event: StreamEvent) => void, options: {
    signal: AbortSignal; choice?: ModelChoice; images?: ImageInput[];
    thinkingLevel?: AgentSession['thinkingLevel']; changed?: (path: string) => void;
    revision?: { sourceEntryId: string; expectedLeafId: string | null };
  }): Promise<string>;
  messages(id: string): ViewMessage[];
  compact(id: string, signal: AbortSignal): Promise<void>;
}
