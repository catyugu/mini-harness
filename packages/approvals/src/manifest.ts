import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/runs/api';
import type {} from '@mini-harness/transport/routes';
import type {} from '@mini-harness/sessions/store';
import { requestApproval } from './server/api.js';
import { isRunning } from '@mini-harness/sessions/run-state';
import { DomainError } from '@mini-harness/platform/errors';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { Approvals } from './server/approvals.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:approvals', title: 'Approvals', description: 'Pending user decisions', defaultEnabled: true,
  inject: ['harnessChanges', 'harnessRoutes', 'harnessRuns', 'harnessRegistry'], provides: ['harnessApprovals', 'harnessApprovalRequests'],
  setup(ctx) {
    const approvals = new Approvals();
    const changes = ctx.harnessChanges;
    ctx.effect(() => changes.register('approvals'));
    ctx.effect(() => {
      const changed = (event: Event) => {
        if (event instanceof CustomEvent) changes.invalidate('approvals', { sessionId: event.detail.id });
      };
      approvals.events.addEventListener('change', changed);
      return () => approvals.events.removeEventListener('change', changed);
    });
    ctx.provide('harnessApprovals', approvals);
    ctx.provide('harnessApprovalRequests', {
      [requestApproval](id: string, plugin: string, prompt: import('./server/api.js').ApprovalPrompt, signal: AbortSignal) {
        ctx.harnessRegistry.assertAvailable(id);
        if (!ctx.harnessRegistry.get(id)) throw new DomainError('not_found', 'Conversation not found');
        const run = ctx.harnessRuns.info(id);
        return approvals.request(id, isRunning(run) ? run?.id : undefined, plugin, prompt,
          ctx.harnessRuns.signal(id, signal) ?? signal);
      }
    });
    ctx.effect(() => ctx.harnessRegistry.beforeDelete({
      async quiesce(ids) { for (const id of ids) approvals.cancelSession(id); }
    }));
    ctx.effect(() => {
      const runs = ctx.harnessRuns;
      const changed = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const run = runs.info(event.detail.id);
        if (run && run.state !== 'queued' && run.state !== 'running') approvals.finishRun(run.id);
      };
      runs.events.addEventListener('change', changed);
      return () => { runs.events.removeEventListener('change', changed); approvals.close(); };
    });
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/approvals', () => approvals.list()));
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/approvals', async ({ body }) => {
      const input = await body() as { id?: string; allow?: boolean } | null;
      if (typeof input?.id !== 'string' || typeof input.allow !== 'boolean') throw new DomainError('invalid_input', 'Choose allow or deny');
      approvals.decide(input.id, input.allow);
      return { ok: true };
    }));
  }
};
