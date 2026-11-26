import type { Context } from 'mini-harness/cordis';
import type { TaskSnapshot } from '@mini-harness/tasks/api';

export const backgroundTool = 'background-tool';

function related(task: TaskSnapshot, sessionId: string, children: Set<string>) {
  return (
    (task.type === backgroundTool && task.owner === 'session:' + sessionId) ||
    (task.type === 'agent-run' && children.has(task.owner))
  );
}

function childrenOf(ctx: Context, id: string) {
  return new Set(
    ctx.harnessSessions
      .list()
      .filter(({ parentId }) => parentId === id)
      .map(({ id }) => 'session:' + id),
  );
}

export function relatedTasks(ctx: Context, id: string) {
  const children = childrenOf(ctx, id);
  const owners = ['session:' + id, ...children];
  const tasks = new Map<string, TaskSnapshot>();
  for (const owner of owners) {
    ctx.harnessSessions.inspectLog(owner.slice('session:'.length), (log) => {
      for (const entry of log.entries())
        if (entry.type === 'task' && related(entry.task, id, children)) tasks.set(entry.task.id, entry.task);
    });
    for (const task of ctx.harnessTasks.list(owner))
      if (related(task, id, children)) tasks.set(task.id, task);
  }
  return [...tasks.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map((task) => ctx.harnessTasks.get(task.id) ?? task);
}

export function relatedTask(ctx: Context, id: string, taskId: string) {
  const task = ctx.harnessTasks.get(taskId);
  if (task && related(task, id, childrenOf(ctx, id))) return task;
}
