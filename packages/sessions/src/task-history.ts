import type { Context } from 'mini-harness/cordis';
import { DomainError } from '@mini-harness/platform/errors';
import type { TaskHistoryRecord } from '@mini-harness/tasks/api';
import type { SessionStore } from './records.ts';

/** Sessions owns durable task facts; the runtime keeps only active and bounded recent state. */
export function bindTaskHistory(ctx: Context, sessions: SessionStore) {
  const sessionId = (owner: string) => (owner.startsWith('session:') ? owner.slice(8) : undefined);
  ctx.on('tasks/admit', (owner) => {
    const id = sessionId(owner);
    if (id === undefined) return;
    sessions.assertAvailable(id);
    if (!sessions.get(id)) throw new DomainError('not_found', 'Conversation not found');
  });
  ctx.on('tasks/record', ({ task, output }) => {
    const id = sessionId(task.owner);
    if (id === undefined || task.parentId) return;
    const run = ctx.bail('sessions/task-details', id, task);
    // The assistant answer already exists in the message log.
    sessions.log(id).append({ type: 'task', task: run ? { ...task, result: undefined } : task, output, run });
  });
  ctx.on('tasks/history', (id): TaskHistoryRecord | undefined => {
    for (const session of sessions.list()) {
      const found = sessions.inspectLog(session.id, (log) => {
        const entries = log.entries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type !== 'task' || entry.task.id !== id) continue;
          const task = entry.task;
          if (!entry.run || task.state !== 'completed') return { task, output: entry.output };
          const start = entries.findIndex(
            (item) => item.type === 'task' && item.task.id === id && item.task.state === 'queued',
          );
          const answer =
            start >= 0
              ? entries
                  .slice(start + 1, i)
                  .reverse()
                  .find((item) => item.type === 'message' && item.message.role === 'assistant')
              : undefined;
          const result =
            answer?.type === 'message' && answer.message.role === 'assistant'
              ? answer.message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
              : undefined;
          return { task: { ...task, result }, output: entry.output };
        }
      });
      if (found) return found;
    }
  });
}
