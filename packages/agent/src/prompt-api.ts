import type { ToolDefinition } from '@mini-harness/tools/api';

export interface PromptContext {
  sessionId: string;
  cwd: string;
  signal: AbortSignal;
  tools: readonly Omit<ToolDefinition, 'execute' | 'isConcurrencySafe'>[];
}
export interface PromptSection {
  id: string;
  order?: number;
  /** Higher priority wins among sections at the same scope depth; equal winning priorities conflict. */
  priority?: number;
  render(context: PromptContext): string | undefined | Promise<string | undefined>;
}


export interface PromptPort {
  build(request: PromptContext): Promise<string>;
  register(section: PromptSection): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessPrompt: PromptPort;
  }
}
