import type { MessageOrigin } from '@mini-harness/sessions/queue';

export function notificationLabel(origin?: MessageOrigin) {
  if (origin && origin.source !== 'user') return origin.label ?? 'Plugin message';
}
