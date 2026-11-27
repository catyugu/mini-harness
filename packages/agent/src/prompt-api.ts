import type { Context } from 'mini-harness/cordis';

export interface PromptContext {
  readonly signal: AbortSignal;
  readonly [field: string]: unknown;
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
  /** Register in the caller’s prompt service and scope under the provider Fiber. */
  register(section: PromptSection, provider?: Context): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessPrompt: PromptPort;
  }
}
