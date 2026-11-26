import type { MessageOrigin } from '@mini-harness/sessions/queue';

/** Completion delivery already has a stable identity shared by both task producers. */
export function notificationLabel(origin: MessageOrigin | undefined, deliveryId?: string) {
  if (!origin || origin.source === 'user') return;
  const settled = origin.taskId && deliveryId === origin.taskId + ':settled';
  if (origin.source === 'agent') return settled ? 'Subagent finished' : 'Agent message';
  if (origin.source === 'task') return settled ? 'Background task finished' : 'Background task report';
  return 'Plugin message';
}
