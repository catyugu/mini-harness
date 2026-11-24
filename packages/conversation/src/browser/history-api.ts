import type {} from 'cordis';
import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';

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
export type AttachmentPreview = (file: NonNullable<ViewMessage['attachments']>[number], sessionId: string) => void;
export type RecordRenderer = (record: SessionDisplayRecord, context: { sessionId: string; signal: AbortSignal }) =>
  HTMLElement | undefined;

declare module 'cordis' {
  interface Context {
    miniMessages: {
      registerRecord(plugin: string, render: RecordRenderer): () => void;
      registerAttachmentPreview(open: AttachmentPreview): () => void;
      registerAction(action: MessageAction): () => void;
      registerTool(name: string, render: ToolRenderer, action?: boolean): () => void;
    };
  }
}
