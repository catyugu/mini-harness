import type {} from '@mini-harness/kernel/scopes';
import type {} from '@mini-harness/sandbox/api';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { executeProcess } from './executor.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:process', title: 'Process execution', description: 'Isolated and explicitly authorized host processes', required: true,
  inject: ['harnessSandbox', 'harnessScopes'], provides: ['harnessProcess'],
  setup(ctx, api) {
    const active = new Set<Promise<unknown>>();
    ctx.provide('harnessProcess', {
      async run(request: Parameters<typeof executeProcess>[0]) {
        const signal = request.signal ? AbortSignal.any([api.signal, request.signal]) : api.signal;
        const environment = ctx.harnessScopes.require(request.sessionId ? `session:${request.sessionId}` : undefined, 'harnessSandbox');
        const running = executeProcess({ ...request, signal }, environment);
        active.add(running);
        try { return await running; }
        finally { active.delete(running); }
      }
    });
    ctx.effect(() => async () => { await Promise.allSettled(active); });
  }
};
