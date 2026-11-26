import type { Plugin } from 'mini-harness/cordis';
import { TaskRuntime } from './runtime.ts';

export const metadata = { title: 'Task Runtime', description: 'Asynchronous work and lifecycle management' };

const plugin: Plugin.Object = {
  provide: ['harnessTasks'],
  apply(ctx) {
    const runtime = new TaskRuntime({
      admit: (owner) => ctx.emit('tasks/admit', owner),
      record: (record) => ctx.emit('tasks/record', record),
      history: (id) => ctx.bail('tasks/history', id),
    });
    ctx.provide('harnessTasks', runtime.service());
    ctx.on('harness/seal', () => runtime.seal());
    ctx.on('harness/quiesce', () => runtime.stop());
    ctx.effect(() => () => runtime.stop());
  },
};

export default plugin;
