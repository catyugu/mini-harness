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
    if (id !== undefined) sessions.log(id).append({ type: 'task', task, output });
  });
  ctx.on('tasks/history', (id): TaskHistoryRecord | undefined => {
    for (const session of sessions.list()) {
      const found = sessions.inspectLog(session.id, (log) => {
        const entries = log.entries();
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i];
          if (entry.type === 'task' && entry.task.id === id)
            return { task: entry.task, output: entry.output };
          if (entry.type === 'run' && entry.run.id === id) {
            const run = entry.run;
            return {
              task: {
                id,
                owner: 'session:' + session.id,
                resourceId: session.id,
                type: 'agent-run',
                creator: run.creator,
                metadata: run.taskMetadata,
                state: run.state,
                createdAt: run.startedAt,
                startedAt: run.executedAt,
                finishedAt: run.finishedAt,
                cancellationRequested: run.state === 'cancelled' || run.state === 'interrupted',
                outputCursor: 0,
                retained: true,
                error: run.error,
              },
            };
          }
        }
      });
      if (found) return found;
    }
  });
}
