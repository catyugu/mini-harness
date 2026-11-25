import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import type { ProcessExecutionPort } from './api.ts';
import { startProcess } from './executor.ts';

export const metadata: PluginInfo = {
  title: 'Process execution',
  description: 'Start subprocesses with streaming stdio and cancellation',
};

const plugin: Plugin.Object = {
  provide: ['harnessProcess'],
  apply(ctx) {
    const execution: ProcessExecutionPort = {
      start(command, signal) {
        const owner = ctx.fiber.signal;
        const child = startProcess(command, signal ? AbortSignal.any([owner, signal]) : owner);
        void ctx.fiber.run(() => child.finished).catch(() => {});
        return child;
      },
    };
    ctx.provide('harnessProcess', execution);
  },
};

export default plugin;
