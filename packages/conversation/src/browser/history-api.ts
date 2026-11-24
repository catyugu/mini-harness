import type {} from 'cordis';
import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';

/** A presentation-only renderer for user text; copy and edit retain the raw message. */
export type UserTextRenderer = (text: string) => Node;
export type ToolRenderer = (tool: ToolView, signal: AbortSignal) => HTMLElement | undefined;
export interface ToolView { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string }
export interface MessageActionContext {
  readonly signal: AbortSignal;
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

declare module 'cordis' {
  interface Context {
    miniMessages: {
      registerUserText(render: UserTextRenderer): () => void;
      registerRecord(plugin: string, render: RecordRenderer): () => void;
      registerAction(action: MessageAction): () => void;
      registerTool(name: string, render: ToolRenderer, action?: boolean): () => void;
    };
  }
}
