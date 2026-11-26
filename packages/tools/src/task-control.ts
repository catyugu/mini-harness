import type { Plugin } from 'mini-harness/cordis';
import { terminal } from '@mini-harness/tasks/api';
import { Type } from 'typebox';
import { defineTool } from './api.ts';

export const metadata = { title: 'Task control', description: 'Inspect, await and cancel tasks.' };

const plugin: Plugin.Object = {
  inject: ['harnessTasks', 'harnessTools'],
  apply(ctx) {
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
                    tasks.wait(taskId, signal ? AbortSignal.any([signal, ownerSignal]) : ownerSignal),
                  )
                : await tasks.wait(taskId, signal);
            } else task = tasks.get(taskId) ?? task;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    taskId,
                    state: task.state,
                    result: task.result,
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
  },
};

export default plugin;
