import type { Context } from 'mini-harness/cordis';
import { defineTool } from '@mini-harness/tools/api';
import { terminal } from '@mini-harness/tasks/api';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import { Delegation, type SubagentPolicy } from './delegation.ts';

/** Optional plugin: delegation, scheduling and child-model rules exist only while mounted. */
export function setup(ctx: Context) {
  const policy = () => ctx.fiber.effectiveConfig as unknown as SubagentPolicy;
  const validate = ({ model }: SubagentPolicy) => {
    if (model && !ctx.harnessModels.resolve(model))
      throw new DomainError('invalid_input', 'Unknown child model: ' + model.provider + '/' + model.id);
  };
  validate(policy());
  const delegation = new Delegation(ctx.harnessSessions, ctx.harnessRuns, policy, ctx);
  ctx.on('internal/update', (next) => {
    const config = next as unknown as SubagentPolicy;
    validate(config);
    delegation.semaphore.setLimit(config.maxParallel);
  });
  const tool = (id: string) =>
    defineTool({
      name: 'delegate',
      label: 'Delegate',
      description:
        'Start a child agent asynchronously. Returns its session ID and task ID immediately; the child continues independently. Use task_control to inspect, await or cancel it. Set provider/model to override the default.',
      parameters: Type.Object({
        task: Type.String({ minLength: 1, maxLength: 12000 }),
        provider: Type.Optional(Type.String({ maxLength: 160 })),
        model: Type.Optional(Type.String({ maxLength: 160 })),
      }),
      isConcurrencySafe: () => true,
      execute: async (_callId, args, signal, _update, context) => {
        const child = delegation.delegate(id, args, signal, context?.task.id);
        return { content: [{ type: 'text', text: JSON.stringify(child) }], details: child };
      },
    });
  ctx.effect(() =>
    ctx.harnessTools.register({ name: 'delegate', resolve: tool, visible: (id) => delegation.visible(id) }),
  );

  const tasks = ctx.harnessTasks;
  ctx.effect(() =>
    ctx.harnessTools.register(
      defineTool({
        name: 'task_control',
        label: 'Task',
        description:
          'Inspect, await, or cancel a task by its Task ID. Waiting releases the current execution slot until the task settles.',
        parameters: Type.Object({
          action: Type.Union([Type.Literal('status'), Type.Literal('wait'), Type.Literal('cancel')]),
          taskId: Type.String({ minLength: 1, maxLength: 128 }),
        }),
        isConcurrencySafe: ({ action }) => action !== 'wait',
        async execute(_callId, { action, taskId }, signal, _update, context) {
          let task = tasks.get(taskId);
          if (!task) throw new Error('Task not found: ' + taskId);
          if (action === 'cancel') tasks.cancel(taskId);
          if (action === 'wait' && !terminal(task.state)) {
            if (taskId === context?.task.id || taskId === context?.owner?.id)
              throw new Error('A task cannot wait for itself or its owner');
            const waiter = context?.owner ?? context?.task;
            task = waiter
              ? await waiter.suspend((ownerSignal) =>
                  tasks.wait(
                    taskId,
                    undefined,
                    signal ? AbortSignal.any([signal, ownerSignal]) : ownerSignal,
                  ),
                )
              : await tasks.wait(taskId, undefined, signal);
          } else task = tasks.get(taskId) ?? task;
          let result = task.result;
          // The answer is already durable in SessionLog; do not copy it into Task Runtime.
          if (task.type === 'agent-run' && task.state === 'completed' && task.resourceId) {
            const answer = ctx.harnessSessions.inspectLog(task.resourceId, (log) => {
              const entries = log.entries();
              const start = entries.findIndex(
                (entry) => entry.type === 'run' && entry.run.id === taskId && entry.run.state === 'queued',
              );
              const end = entries.findIndex(
                (entry, index) =>
                  index > start &&
                  entry.type === 'run' &&
                  entry.run.id === taskId &&
                  entry.run.state === 'completed',
              );
              if (start < 0 || end < 0) return;
              const last = entries
                .slice(start + 1, end)
                .reverse()
                .find((entry) => entry.type === 'message' && entry.message.role === 'assistant');
              if (last?.type !== 'message' || last.message.role !== 'assistant') return;
              return last.message.content
                .flatMap((part) => (part.type === 'text' ? [part.text] : []))
                .join('');
            });
            if (answer !== undefined) result = answer;
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  taskId,
                  state: task.state,
                  result,
                  error: task.error,
                  cancellationRequested: task.cancellationRequested,
                }),
              },
            ],
          };
        },
      }),
    ),
  );
}
