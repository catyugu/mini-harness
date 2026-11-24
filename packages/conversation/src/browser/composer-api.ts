import type {} from 'cordis';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { ModelChoice, ThinkingLevel } from '@mini-harness/llm/vocabulary';
import type { Attachment } from '@mini-harness/input/message';

export interface ComposerCommand {
  name: string;
  description: string;
  group?: string;
  /** Additional prefixes that find this command in the palette. */
  aliases?: readonly string[];
  /** With no callback the palette inserts the command for the next message. */
  run?: () => void | Promise<void>;
}

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

export interface DraftMode {
  title: string;
  text: string;
  images?: Attachment[];
  revision: { sourceEntryId: string; expectedLeafId: string | null };
}

export interface ComposerDraft {
  readonly text: string;
  readonly attachments: readonly Readonly<Attachment>[];
  readonly model?: Readonly<ModelChoice>;
  readonly thinkingLevel?: ThinkingLevel | null;
  readonly editTitle?: string;
  readonly loading: boolean;
}

export interface ComposerModel {
  draft(): ComposerDraft;
  subscribe(listener: (focus: boolean) => void, signal: AbortSignal): void;
  insert(text: string): void;
  setText(text: string, start?: number, end?: number): void;
  cursor(): number;
  addFiles(files: readonly File[]): Promise<void>;
  removeAttachment(index: number): void;
  choose(model?: ModelChoice): void;
  chooseThinking(level: ThinkingLevel | null): void;
  permission(): ConversationPermission;
  setPermission(permission: ConversationPermission): Promise<void>;
  beginDraftMode(mode: DraftMode): () => void;
  cancelEdit(): void;
  send(queued?: boolean): Promise<void>;
  retry(): Promise<void>;
  matchCommands(query: string): ComposerCommand[];
  completer(trigger: string): Completer | undefined;
  command(command: ComposerCommand): () => void;
  completion(trigger: string, complete: Completer): () => void;
}

declare module 'cordis' {
  interface Context { miniComposer: ComposerModel }
}
