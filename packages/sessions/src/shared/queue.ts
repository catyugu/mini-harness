import type { InputSource } from '@mini-harness/input/message';

export const messageModes = ['steer', 'interrupt', 'queue'] as const;
export type MessageMode = (typeof messageModes)[number];
export const defaultMessageMode: MessageMode = 'interrupt';

export interface MessageOrigin {
  source: InputSource;
  label?: string;
  senderSessionId?: string;
  taskId?: string;
}

export interface QueueEntry {
  id: string;
  mode: MessageMode;
  summary: string;
  state: 'pending' | 'failed';
  origin?: MessageOrigin;
  reason?: string;
}
