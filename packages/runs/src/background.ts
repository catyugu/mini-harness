import type { Context, Plugin } from 'mini-harness/cordis';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { terminal, type TaskData, type TaskSnapshot } from '@mini-harness/tasks/api';
import { defineTool, type ToolResult } from '@mini-harness/tools/api';
import { executePreparedTool, prepareTool } from '@mini-harness/tools/invocation';
import { conversationTools } from './tool-selection.ts';

export const metadata = { title: 'Background tasks' };

const backgroundTool = 'background-tool';

function relatedSessions(ctx: Context, id: string, includeChildren = true): [string, string][] {
  return [
    [id, backgroundTool],
    ...(includeChildren
      ? ctx.harnessSessions
          .list()
          .filter(({ parentId }) => parentId === id)
          .map(({ id }): [string, string] => [id, 'agent-run'])
      : []),
  ];
}

function relatedTasks(ctx: Context, id: string, includeChildren = true, detail = false) {
  const scopes = relatedSessions(ctx, id, includeChildren);
  const live = ctx.harnessTasks.list(new Set(scopes.map(([id]) => 'session:' + id)));
  const types = new Map(scopes);
  const matching = live.filter((task) => task.type === types.get(task.owner.slice('session:'.length)));
  const skip = new Set(matching.map((task) => task.id));
  const ended = scopes
    .flatMap(([session, type]) => ctx.harnessSessions.tasks(session, type, 50, skip))
    .filter((task) => terminal(task.state));
  const newest = (a: { createdAt: string }, b: { createdAt: string }) =>
    b.createdAt.localeCompare(a.createdAt);
  return [
    ...matching.filter((task) => !terminal(task.state)).sort(newest),
    ...ended
      .concat(matching.filter((task) => terminal(task.state)))
      .sort(newest)
      .slice(0, 50)
      .map((task) => {
        if (!detail || skip.has(task.id)) return task;
        const record = ctx.harnessSessions.taskStatus(task.owner.slice('session:'.length), task.id);
        if (!record) throw new Error('Missing indexed task: ' + task.id);
        return record;
      }),
  ];
}

function relatedTask(ctx: Context, id: string, taskId: string) {
  const live = ctx.harnessTasks.get(taskId);
  for (const [session, type] of relatedSessions(ctx, id)) {
    const task = live ?? ctx.harnessSessions.taskStatus(session, taskId, false);
    if (task?.owner === 'session:' + session && task.type === type) return task;
  }
}

function writableToolResult(result: ToolResult) {
  return {
    content: result.content.flatMap((part) => (part.type === 'text' ? [part.text.slice(0, 4000)] : [])),
  };
}

function sendNotice(ctx: Context, id: string, taskId: string, name: string, message: string, key: string) {
  if (ctx.fiber.signal.aborted || ctx.harnessTasks.sealed || !ctx.harnessSessions.get(id)) return;
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
  if (!prepared.binding) throw new Error('Background tool has no registered provider: ' + name);
  const task = ctx.harnessTasks.start(
    {
      ...service.task(id),
      type: backgroundTool,
      name: tool.label ?? tool.name,
      metadata: { tool: name, arguments: prepared.args as TaskData },
      provider: prepared.binding.provider,
      signal: prepared.binding.signal,
      project: (result: ToolResult) =>
        ({
          ...(tool.projectResult?.(result) ?? writableToolResult(result)),
          toolState: result.state,
        }) as TaskData,
    },
    (task) => {
      service.assertAvailable(id);
      if (provider.get('harnessToolPolicy')?.(id, tool) === false)
        throw new Error('Tool denied by conversation policy: ' + name);
      let reports = 0;
      return executePreparedTool(prepared, callId, {
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
  return { taskId: task.id, state: 'accepted' };
}

const plugin: Plugin.Object = {
  inject: ['harnessTasks', 'harnessTools', 'harnessSessions', 'harnessRuns', 'harnessProfileScopes'],
  apply(ctx) {
    const tasks = ctx.harnessTasks;
    const sessions = ctx.harnessSessions;
    const output = (task: TaskSnapshot, cursor?: number) =>
      tasks.readOutput(task.id, cursor) ??
      sessions.taskOutput(task.owner.slice('session:'.length), task.id, cursor);
    const json = (data: unknown): ToolResult => ({ state: 'finished', content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
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
              if (action === 'output') return json(output(task, cursor));
              if (action === 'cancel') tasks.cancel(task.id);
              if (action === 'wait' && tasks.get(task.id) && !terminal(task.state)) {
                if (waitFor) await waitFor(task.id);
                else await tasks.wait(task.id, signal);
              }
              return json(
                tasks.get(task.id) ??
                  sessions.taskStatus(task.owner.slice('session:'.length), task.id) ??
                  task,
              );
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
      for (const { id } of sessions.list())
        for (const task of sessions.tasks(id, backgroundTool))
          if (terminal(task.state) && !sessions.hasInbox(id, task.id + ':settled')) {
            const record = sessions.taskStatus(id, task.id);
            if (!record) throw new Error('Missing indexed task: ' + task.id);
            settled(ctx, record);
          }
    });
    ctx.inject(['harnessRoutes', 'harnessChanges'], (web) => {
      const changes = web.harnessChanges;
      web.effect(() => changes.register('tasks'));
      web.effect(() =>
        tasks.subscribe(({ task }) => {
          if (task.type === backgroundTool) changes.invalidate('tasks', task.owner.slice('session:'.length));
        }),
      );
      const route = '/api/sessions/:id/tasks';
      web.effect(() =>
        web.harnessRoutes.register('GET', route, ({ params }) => relatedTasks(ctx, params.id, false, true)),
      );
      web.effect(() =>
        web.harnessRoutes.register('GET', route + '/:task/output', ({ params, url }) => {
          const task = relatedTask(ctx, params.id, params.task);
          if (!task) throw new DomainError('not_found', 'Task not found');
          const cursor = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(cursor) || cursor < 0)
            throw new DomainError('invalid_input', 'Invalid cursor');
          return output(task, cursor);
        }),
      );
      web.effect(() =>
        web.harnessRoutes.register('DELETE', route + '/:task', ({ params }) => {
          const task = relatedTask(ctx, params.id, params.task);
          if (!task) throw new DomainError('not_found', 'Task not found');
          return { cancelled: tasks.cancel(task.id) };
        }),
      );
    });
  },
};
export default plugin;
