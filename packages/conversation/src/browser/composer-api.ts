import type {} from 'cordis';
import type { BrowserContributionSource } from '@mini-harness/ui-runtime/contribution';
import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { Attachment } from '@mini-harness/input/message';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { RunInfo } from '@mini-harness/sessions/run-state';

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
  icon: PluginIcon;
  order?: number;
  visible(context: MessageActionContext): boolean;
  run(context: MessageActionContext): void | Promise<void>;
}
export type RecordRenderer = (record: SessionDisplayRecord, context: { sessionId: string; signal: AbortSignal }) =>
  HTMLElement | undefined;

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
      registerRecord(plugin: string, render: RecordRenderer): () => void;
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
  record(source: BrowserContributionSource, render: RecordRenderer, plugin = source.id) {
    return source.effect(() => source.service('miniMessages').registerRecord(plugin, render));
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

declare module '@mini-harness/ui-slots/browser/api' {
  interface SlotMap {
    'workspace.welcome': { kind: 'single' };
    'conversation.composer': { kind: 'list' };
    'conversation.composer-view': { kind: 'single' };
    'conversation.history': { kind: 'single' };
    'conversation.approvals': { kind: 'list' };
  }
}
