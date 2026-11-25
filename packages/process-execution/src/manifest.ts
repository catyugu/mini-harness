import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { executeProcess } from './executor.ts';

export const metadata: PluginInfo = {
  title: 'Process execution',
  description: 'Run subprocesses with cancellation, time and output limits',
};

const plugin: Plugin.Object = {
  provide: ['harnessProcess'],
  apply(ctx) {
    ctx.provide('harnessProcess', {
      run(request: Parameters<typeof executeProcess>[0]) {
        return ctx.fiber.run((signal) => executeProcess({ ...request, signal }), request.signal);
      },
    });
  },
};

export default plugin;
