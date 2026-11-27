import type { Context } from 'mini-harness/cordis';
import { terminal, type TaskSnapshot } from '@mini-harness/tasks/api';

export const backgroundTool = 'background-tool';

export function relatedTasks(ctx: Context, id: string, includeChildren = true, detailed = false) {
  const sessions = ctx.harnessSessions;
  const scopes = [[id, backgroundTool]] as [string, string][];
  if (includeChildren)
    for (const child of sessions.list()) if (child.parentId === id) scopes.push([child.id, 'agent-run']);

  const live = new Map<string, TaskSnapshot>();
  const history = scopes.flatMap(([session, type]) => {
    for (const task of ctx.harnessTasks.list('session:' + session))
      if (task.type === type) live.set(task.id, task);
    return sessions.taskSummaries(session, type, 50);
  });
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
