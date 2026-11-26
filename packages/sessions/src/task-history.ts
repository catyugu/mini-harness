import type { TaskHistoryRecord } from '@mini-harness/tasks/api';
import type { SessionEntry } from './log-api.ts';

/** Reconstruct the compact observation from its owning log, not a live handle. */
export function readTaskHistory(entries: SessionEntry[], id: string): TaskHistoryRecord | undefined {
  const entry = [...entries].reverse().find((item) => item.type === 'task' && item.task.id === id);
  if (entry?.type !== 'task') return;
  const { task, output, run } = entry;
  if (!run || task.state !== 'completed') return { task, output };
  const start = entries.findIndex(
    (item) => item.type === 'task' && item.task.id === id && item.task.state === 'queued',
  );
  const end = entries.indexOf(entry);
  const answer =
    start >= 0
      ? entries
          .slice(start + 1, end)
          .reverse()
          .find((item) => item.type === 'message' && item.message.role === 'assistant')
      : undefined;
  const result =
    answer?.type === 'message' && answer.message.role === 'assistant'
      ? answer.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
      : undefined;
  return { task: { ...task, result }, output };
}
