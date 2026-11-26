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
          async execute({ action, taskId }, { waitFor }) {
            let task = tasks.get(taskId);
            if (!task) throw new Error('Task not found: ' + taskId);
            if (action === 'cancel') tasks.cancel(taskId);
            if (action === 'wait' && !terminal(task.state)) {
              task = await waitFor(taskId);
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
