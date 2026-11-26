import type { Context } from 'mini-harness/cordis';
import type { LlmRequest, NativeAssistantMessage, NativeUsage } from '@mini-harness/llm/api';
import type { SessionLogPort, SessionContext } from '@mini-harness/sessions/log-api';
import type { ToolDefinition } from '@mini-harness/tools/api';

export interface ContextRequest {
  ctx: Context;
  log: SessionLogPort;
  signal: AbortSignal;
  assemble(projection: SessionContext): Promise<LlmRequest>;
  assembleSummary(request: LlmRequest): Promise<LlmRequest>;
  summarize(request: LlmRequest): Promise<NativeAssistantMessage>;
  tools: ReadonlyMap<string, ToolDefinition>;
}

export type ContextRepair = { kind: 'context-overflow' | 'image-limit'; message: string; attempt: number };

declare module 'mini-harness/cordis' {
  interface Context {
    harnessContextManagement: {
      prepare(input: ContextRequest, repair?: ContextRepair): Promise<LlmRequest>;
      observe(request: Omit<LlmRequest, 'signal'>, usage: NativeUsage): void;
      compact(input: ContextRequest): Promise<void>;
    };
  }
}
