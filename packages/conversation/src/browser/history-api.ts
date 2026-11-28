import type { PluginIcon } from '@mini-harness/plugin-api/descriptor';
import type { LiveRecord } from '@mini-harness/runs/stream';
import type { NativeToolMessage, ToolResultState } from '@mini-harness/llm/api';
import type { ViewMessage } from '@mini-harness/sessions/message';

export type ToolPlacement = 'body' | 'action' | 'summary' | 'status';
export type ToolRenderer = (tool: ToolView, signal: AbortSignal) => HTMLElement | undefined;
export interface ToolView {
  name: string;
  state: ToolResultState | 'running' | 'approval';
  content?: NativeToolMessage['content'];
  arguments?: unknown;
  details?: Record<string, unknown>;
  streams?: Readonly<Record<string, string>>;
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
  record: LiveRecord,
  context: {
    sessionId: string;
    signal: AbortSignal;
    subscribe(listener: (record: LiveRecord) => void): void;
  },
) => HTMLElement | undefined;

declare module 'mini-harness/cordis' {
  interface Context {
    miniMessages: {
      registerTurnFooter(id: string, render: TurnFooterRenderer): () => void;
      registerRecord(plugin: string, kind: string, render: RecordRenderer, priority?: number): () => void;
      registerAction(action: MessageAction): () => void;
      registerTool(
        name: string,
        render: ToolRenderer,
        placement?: ToolPlacement,
        priority?: number,
      ): () => void;
    };
  }
}
