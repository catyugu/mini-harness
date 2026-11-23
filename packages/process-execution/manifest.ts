import type { PluginDescriptor } from '../contracts/plugins.js';
import { executeProcess } from './executor.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  id: 'core:process', title: 'Process execution', description: 'Isolated and explicitly authorized host processes', required: true, replaceable: true,
  inject: ['harnessSandbox'], provides: ['harnessProcess'],
  setup(ctx, api) {
    const sandbox = ctx.harnessSandbox;
    const active = new Set<Promise<unknown>>();
    ctx.provide('harnessProcess', {
      async run(request: Parameters<typeof executeProcess>[0]) {
        const signal = request.signal ? AbortSignal.any([api.signal, request.signal]) : api.signal;
        const running = executeProcess({ ...request, signal }, sandbox);
        active.add(running);
        try { return await running; }
        finally { active.delete(running); }
      }
    });
    api.onDispose(async () => { await Promise.allSettled(active); });
  }
};
