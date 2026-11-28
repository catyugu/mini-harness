import type { Plugin } from 'mini-harness/cordis';
import { TaskRuntime } from './runtime.ts';

export const metadata = { title: 'Task Runtime', description: 'Asynchronous work and lifecycle management' };

const plugin: Plugin.Object = {
  provide: ['harnessTasks'],
  apply(ctx) {
    const runtime = new TaskRuntime(ctx);
    ctx.provide('harnessTasks', runtime.service());
    ctx.on('harness/seal', () => runtime.seal());
    ctx.on('harness/quiesce', () => runtime.stop());
    ctx.effect(() => () => runtime.stop());
  },
};

export default plugin;
