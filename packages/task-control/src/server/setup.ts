import type { Context, Plugin } from 'mini-harness/cordis';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { terminal, type TaskData, type TaskSnapshot } from '@mini-harness/tasks/api';
import { defineTool, type ToolResult } from '@mini-harness/tools/api';
import { invokeTool, prepareTool, withToolLease } from '@mini-harness/tools/invocation';
import { conversationTools } from '@mini-harness/sessions/tool-selection';
import { backgroundTool, relatedTask, relatedTasks } from './related-tasks.ts';

function writableToolResult(result: ToolResult) {
  return {
    ...(result.outcome && { outcome: result.outcome }),
    content: result.content.flatMap((part) => (part.type === 'text' ? [part.text.slice(0, 4000)] : [])),
  };
}

function sendNotice(ctx: Context, id: string, taskId: string, name: string, message: string, key: string) {
  if (ctx.harnessTasks.sealed || !ctx.harnessSessions.get(id)) return;
  ctx.harnessSessions.assertAvailable(id);
  ctx.harnessRuns.send(id, {
    message: name + ': ' + message,
    messageId: taskId + ':' + key,
    mode: 'queue',
    origin: { source: 'task', taskId },
  });
}

function settled(ctx: Context, task: TaskSnapshot) {
  const id = task.owner.slice('session:'.length);
  try {
    const description = JSON.stringify(task.result ?? task.error ?? null).slice(0, 4200);
    sendNotice(ctx, id, task.id, task.name ?? 'Background tool', task.state + ' ' + description, 'settled');
  } catch (error) {
    if (!(error instanceof DomainError && ['not_found', 'conflict'].includes(error.code)))
      ctx.logger.error('Could not deliver task notification ' + task.id, error);
  }
}

function start(ctx: Context, id: string, name: string, args: Record<string, unknown>, callId: string) {
  const service = ctx.harnessSessions;
  const provider = ctx.harnessProfileScopes.context(`session:${id}`);
  const tool = conversationTools(provider, id, service.scope(id)).find(
    (candidate) => candidate.name === name,
  );
  if (!tool?.background) throw new Error('Tool does not support background execution: ' + name);
  const prepared = prepareTool(tool, args);
  let taskId: string | undefined;
  withToolLease(prepared, (lifetime, owner) => {
    const task = ctx.harnessTasks.start(
      {
        ...service.task(id),
        type: backgroundTool,
        name: tool.label ?? tool.name,
        metadata: { tool: name, arguments: prepared.args as TaskData },
        provider: owner ?? ctx,
        signal: lifetime,
        project: (result: ToolResult) =>
          ({
            ...(tool.projectResult?.(result) ?? writableToolResult(result)),
            isError: Boolean(result.isError || result.outcome),
          }) as TaskData,
      },
      (task) => {
        service.assertAvailable(id);
        if (provider.get('harnessToolPolicy')?.(id, tool) === false)
          throw new Error('Tool denied by conversation policy: ' + name);
        let reports = 0;
        return invokeTool(prepared, callId, {
          signal: task.signal,
          onUpdate: (update) => task.update(update as TaskData),
          write: task.write,
          report: (message) => sendNotice(ctx, id, task.id, name, message, 'report:' + ++reports),
          waitFor: async (id, signal) => {
            await task.waitFor(id, signal);
          },
        });
      },
    );
    taskId = task.id;
    return task.result;
  });
  return { taskId: taskId!, state: 'accepted' };
}

const plugin: Plugin.Object = {
  inject: ['harnessTasks', 'harnessTools', 'harnessSessions', 'harnessRuns', 'harnessProfileScopes'],
  apply(ctx) {
    const tasks = ctx.harnessTasks;
    const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
    ctx.effect(() =>
      ctx.harnessTools.register({
        name: 'start_background',
        resolve: (id) =>
          defineTool({
            name: 'start_background',
            label: 'Background task',
            description:
              'Start an eligible tool independently. The receipt identifies the task. Use task_control to inspect it.',
            parameters: Type.Object({
              tool: Type.String(),
              arguments: Type.Record(Type.String(), Type.Unknown()),
            }),
            async execute(args, { callId, signal }) {
              signal.throwIfAborted();
              const receipt = start(ctx, id, args.tool, args.arguments, callId);
              return { ...json(receipt), details: receipt, detailKeys: ['taskId', 'state'] };
            },
          }),
      }),
    );
    ctx.effect(() =>
      ctx.harnessTools.register({
        name: 'task_control',
        resolve: (id) =>
          defineTool({
            name: 'task_control',
            label: 'Task',
            description:
              'List, inspect, read output from, await, or cancel background work or a direct child run.',
            parameters: Type.Object({
              action: Type.Union(
                ['list', 'status', 'output', 'wait', 'cancel'].map((action) => Type.Literal(action)),
              ),
              taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
              cursor: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
            isConcurrencySafe: ({ action }) => action !== 'wait',
            async execute({ action, taskId, cursor }, { waitFor, signal }) {
              if (action === 'list') return json(relatedTasks(ctx, id).map(({ result: _, ...task }) => task));
              const task = taskId && relatedTask(ctx, id, taskId);
              if (!task) throw new DomainError('not_found', 'Task not found');
              if (action === 'output') return json(tasks.readOutput(task.id, cursor));
              if (action === 'cancel') tasks.cancel(task.id);
              if (action === 'wait' && !terminal(task.state)) {
                if (waitFor) await waitFor(task.id);
                else await tasks.wait(task.id, signal);
              }
              return json(tasks.get(task.id) ?? task);
            },
          }),
      }),
    );
    ctx.effect(() =>
      tasks.subscribe(({ type, task }) => {
        if (type === 'transition' && task.type === backgroundTool && terminal(task.state))
          queueMicrotask(() => settled(ctx, task));
      }),
    );
    ctx.on('harness/start', () => {
      for (const { id } of ctx.harnessSessions.list()) {
        const records = ctx.harnessSessions.inspectLog(id, (log) => log.entries());
        const ids = new Set(
          records?.flatMap((entry) =>
            entry.type === 'task' && entry.task.type === backgroundTool ? [entry.task.id] : [],
          ),
        );
        for (const id of ids) {
          const task = tasks.get(id);
          if (task && terminal(task.state)) settled(ctx, task);
        }
      }
    });
  },
};
export default plugin;

/** HTTP inspection belongs to the independently selectable panel, not tool registration. */
export const panel: Plugin.Object = {
  inject: ['harnessTasks', 'harnessSessions', 'harnessRoutes', 'harnessChanges'],
  apply(ctx) {
    const tasks = ctx.harnessTasks;
    const changes = ctx.harnessChanges;
    ctx.effect(() => changes.register('tasks'));
    ctx.effect(() =>
      tasks.subscribe(({ task }) => {
        if (task.type === backgroundTool) changes.invalidate('tasks', task.owner.slice('session:'.length));
      }),
    );
    const route = '/api/sessions/:id/tasks';
    ctx.effect(() =>
      ctx.harnessRoutes.register('GET', route, ({ params }) => relatedTasks(ctx, params.id, false)),
    );
    ctx.effect(() =>
      ctx.harnessRoutes.register('GET', route + '/:task/output', ({ params, url }) => {
        const task = relatedTask(ctx, params.id, params.task);
        if (!task) throw new DomainError('not_found', 'Task not found');
        const cursor = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(cursor) || cursor < 0)
          throw new DomainError('invalid_input', 'Invalid cursor');
        return tasks.readOutput(task.id, cursor);
      }),
    );
    ctx.effect(() =>
      ctx.harnessRoutes.register('DELETE', route + '/:task', ({ params }) => {
        const task = relatedTask(ctx, params.id, params.task);
        if (!task) throw new DomainError('not_found', 'Task not found');
        return { cancelled: tasks.cancel(task.id) };
      }),
    );
  },
};
