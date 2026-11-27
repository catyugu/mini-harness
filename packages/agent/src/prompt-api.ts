import type { ScopeKey } from '@mini-harness/plugin-api/scopes';

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
  register(section: PromptSection, scope?: ScopeKey): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessPrompt: PromptPort;
  }
}
