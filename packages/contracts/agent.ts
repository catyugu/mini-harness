import type { SessionRecord, ModelChoice } from './conversation.js';
import type { ImageInput, PreparedMessage } from './input.js';
import type { StreamEvent } from './transport.js';
import type { ViewMessage } from './message.js';

/** Native execution capabilities consumed by scheduling services. */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface PromptPort {
  build(request: { sessionId: string; cwd: string; tools: import('./tools.js').ToolDefinition[] }): Promise<string>;
}

declare module 'cordis' {
  interface Context { harnessPrompt: PromptPort }
}

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
