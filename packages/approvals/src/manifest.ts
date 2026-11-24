import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/runs/api';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/transport/routes';
import { DomainError } from '@mini-harness/platform/errors';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { Approvals } from './server/approvals.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:approvals', title: 'Approvals', description: 'Pending user decisions', required: true,
  inject: ['harnessChanges', 'harnessRoutes', 'harnessRuns', 'harnessRegistry'], provides: ['harnessApprovals'],
  browser: '/packages/approvals/src/browser/setup.js', browserInject: ['miniProjections'], browserProvides: ['miniApprovals'],
  setup(ctx) {
    const approvals = new Approvals(ctx.harnessRuns, ctx.harnessRegistry);
    ctx.effect(() => ctx.harnessRegistry.beforeDelete({ async quiesce(ids) { approvals.cancelSessions(ids); } }));
    ctx.on('harness/quiesce', () => approvals.close());
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
