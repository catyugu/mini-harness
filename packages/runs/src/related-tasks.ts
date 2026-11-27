import type { Context } from 'mini-harness/cordis';
import { terminal, type TaskSnapshot } from '@mini-harness/tasks/api';

export const backgroundTool = 'background-tool';

export function relatedTasks(ctx: Context, id: string, includeChildren = true, detailed = false) {
  const sessions = ctx.harnessSessions;
  const scopes = new Map([['session:' + id, backgroundTool]]);
  if (includeChildren)
    for (const child of sessions.list())
      if (child.parentId === id) scopes.set('session:' + child.id, 'agent-run');

  const live = new Map<string, TaskSnapshot>();
  for (const task of ctx.harnessTasks.list(new Set(scopes.keys())))
    if (task.type && scopes.get(task.owner) === task.type) live.set(task.id, task);
  const history = [...scopes].flatMap(([owner, type]) =>
    sessions.taskSummaries(owner.slice('session:'.length), type, 50),
  );
  const results = new Map<string, TaskSnapshot>(history.map((task) => [task.id, task]));
  for (const task of live.values()) results.set(task.id, task);
  const ordered = [...results.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const selected = [
    ...ordered.filter((task) => live.has(task.id) && !terminal(task.state)),
    ...ordered.filter((task) => !live.has(task.id) || terminal(task.state)).slice(0, 50),
  ];
  return selected.map((task) =>
    !live.has(task.id) && (detailed || !terminal(task.state)) ? sessions.taskHistory(task.id)! : task,
  );
}

export function relatedTask(ctx: Context, id: string, taskId: string) {
  const task = ctx.harnessTasks.get(taskId) ?? ctx.harnessSessions.taskSummary(taskId);
  if (!task) return;
  if (task.type === backgroundTool && task.owner === 'session:' + id) return task;
  if (
    task.type === 'agent-run' &&
    ctx.harnessSessions.get(task.owner.slice('session:'.length))?.parentId === id
  )
    return task;
}
