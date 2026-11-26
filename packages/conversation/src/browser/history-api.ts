import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';

export type ToolRenderer = (tool: ToolView, signal: AbortSignal) => HTMLElement | undefined;
export interface ToolView {
  name: string;
  state: string;
  content?: MessageContent;
  arguments?: unknown;
  sessionId?: string;
  taskId?: string;
}
export type MessageActionTarget =
  | {
      readonly type: 'user-message';
      readonly message: Extract<ViewMessage, { role: 'user' }>;
      readonly rawText: string;
    }
  | {
      readonly type: 'assistant-turn';
      readonly id: string;
      readonly messages: readonly ViewMessage[];
      readonly rawText: string;
    };

export interface MessageActionContext {
  readonly signal: AbortSignal;
  readonly sessionId: string;
  readonly leafId?: string | null;
  readonly target: MessageActionTarget;
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
export type TurnFooterRenderer = (context: {
  sessionId: string;
  messageId: string;
  signal: AbortSignal;
}) => HTMLElement;

export type RecordRenderer = (
  record: SessionDisplayRecord,
  context: {
    sessionId: string;
    signal: AbortSignal;
    subscribe(listener: (record: SessionDisplayRecord) => void): void;
  },
) => HTMLElement | undefined;

declare module 'mini-harness/cordis' {
  interface Context {
    miniMessages: {
      registerTurnFooter(id: string, render: TurnFooterRenderer): () => void;
      registerRecord(plugin: string, kind: string, render: RecordRenderer, priority?: number): () => void;
      registerAction(action: MessageAction): () => void;
      registerTool(name: string, render: ToolRenderer, action?: boolean, priority?: number): () => void;
    };
  }
}
