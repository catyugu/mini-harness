import type {} from 'cordis';
import type { BrowserContributionSource } from './browser.js';
import type { ModelChoice } from './conversation.js';
import type { Attachment } from './input.js';
import type { MessageContent, ViewMessage } from './message.js';
import type { RunInfo } from './transport.js';

export interface ComposerCommand {
  name: string;
  description: string;
  group?: string;
  /** Additional prefixes that find this command in the palette. */
  aliases?: readonly string[];
  /** With no callback the palette inserts the command for the next message. */
  run?: () => void | Promise<void>;
}


export interface ToolView { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string }
export interface Suggestion {
  label: string;
  description?: string;
  group?: string;
  icon?: 'file' | 'folder' | 'folder-open';
  depth?: number;
  expanded?: boolean;
  run(complete?: boolean): void;
}
export interface Completion {
  query: string;
  signal: AbortSignal;
  show(entries: Suggestion[], emptyText?: string): void;
  replace(text: string): void;
}
export type Completer = (request: Completion) => void | Promise<void>;

export interface MessageActionContext {
  readonly sessionId?: string;
  readonly leafId?: string | null;
  readonly message: ViewMessage;
  readonly rawText: string;
}
export interface MessageAction {
  id: string;
  label: string;
  successLabel?: string;
  icon: 'copy' | 'edit' | 'refresh';
  order?: number;
  visible(context: MessageActionContext): boolean;
  run(context: MessageActionContext): void | Promise<void>;
}
export interface DraftMode {
  title: string;
  text: string;
  images?: Attachment[];
  submit(input: { text: string; attachments: Attachment[]; removedImages: number[]; model?: ModelChoice; thinkingLevel?: string | null }): Promise<RunInfo>;
}

declare module 'cordis' {
  interface Context {
    miniComposer: {
      insert(text: string): void;
      beginDraftMode(mode: DraftMode): () => void;
      command(command: ComposerCommand): () => void;
      completion(trigger: string, complete: Completer): () => void;
    };
    miniMessages: {
      registerAction(action: MessageAction): () => void;
      registerTool(name: string, render: (tool: ToolView) => HTMLElement | undefined, action?: boolean): () => void;
    };
  }
}

export const conversationExtensions = {
  command(source: BrowserContributionSource, command: ComposerCommand) {
    return source.effect(() => source.service('miniComposer').command(command));
  },
  completion(source: BrowserContributionSource, trigger: string, complete: Completer) {
    return source.effect(() => source.service('miniComposer').completion(trigger, complete));
  },
  draft(source: BrowserContributionSource, mode: DraftMode) {
    return source.effect(() => source.service('miniComposer').beginDraftMode(mode));
  },
  messageAction(source: BrowserContributionSource, action: MessageAction) {
    return source.effect(() => source.service('miniMessages').registerAction(action));
  },
  tool(source: BrowserContributionSource, name: string, render: (tool: ToolView) => HTMLElement | undefined) {
    return source.effect(() => source.service('miniMessages').registerTool(name, render));
  },
  toolAction(source: BrowserContributionSource, name: string, render: (tool: ToolView) => HTMLElement | undefined) {
    return source.effect(() => source.service('miniMessages').registerTool(name, render, true));
  }
};
