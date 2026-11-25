import type { ApprovalRequests } from './server/api.ts';
import { Service, type Plugin } from 'mini-harness/cordis';
import { entryFiber } from '@mini-harness/plugin-api/plugin-configuration';
import { isRunning } from '@mini-harness/sessions/run-state';
import { DomainError } from '@mini-harness/platform/errors';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { Approvals } from './server/approvals.ts';

export const metadata: PluginInfo = {
  title: 'Approvals',
  description: 'Pending user decisions',
};

const plugin: Plugin.Object = {
  inject: ['harnessChanges', 'harnessRuns', 'harnessRegistry'],
  provide: ['harnessApprovals', 'harnessApprovalRequests'],
  apply(ctx) {
    const approvals = new Approvals();
    const changes = ctx.harnessChanges;
    ctx.effect(() => changes.register('approvals'));
    ctx.effect(() => {
      const changed = (event: Event) => {
        if (event instanceof CustomEvent) changes.invalidate('approvals', event.detail.id);
      };
      approvals.events.addEventListener('change', changed);
      return () => approvals.events.removeEventListener('change', changed);
    });
    ctx.provide('harnessApprovals', approvals);
    const requests: ApprovalRequests = Service.track({
      request(id, prompt, signal) {
        const caller = Service.caller(this);
        const instanceId = entryFiber(caller)?.entry?.options.id ?? 'fiber:' + caller.fiber.uid;
        ctx.harnessRegistry.assertAvailable(id);
        if (!ctx.harnessRegistry.get(id)) throw new DomainError('not_found', 'Conversation not found');
        const run = ctx.harnessRuns.info(id);
        return caller.fiber.run(
          (lifetime) =>
            approvals.request(
              id,
              isRunning(run) ? run?.id : undefined,
              instanceId,
              prompt,
              ctx.harnessRuns.signal(id, lifetime) ?? lifetime,
            ),
          signal,
        );
      },
    });
    ctx.provide('harnessApprovalRequests', requests);
    ctx.effect(() =>
      ctx.harnessRegistry.beforeDelete({
        async quiesce(ids) {
          for (const id of ids) approvals.cancelSession(id);
        },
      }),
    );
    ctx.effect(() => {
      const runs = ctx.harnessRuns;
      const changed = (event: Event) => {
        if (!(event instanceof CustomEvent)) return;
        const run = runs.info(event.detail.id);
        if (run && run.state !== 'queued' && run.state !== 'running') approvals.finishRun(run.id);
      };
      runs.events.addEventListener('change', changed);
      return () => {
        runs.events.removeEventListener('change', changed);
        approvals.close();
      };
    });
    ctx.inject(['harnessRoutes'], (web) => {
      web.effect(() => web.harnessRoutes.register('GET', '/api/approvals', () => approvals.list()));
      web.effect(() =>
        web.harnessRoutes.register('POST', '/api/approvals', async ({ body }) => {
          const input = (await body()) as { id?: string; allow?: boolean } | null;
          if (typeof input?.id !== 'string' || typeof input.allow !== 'boolean')
            throw new DomainError('invalid_input', 'Choose allow or deny');
          approvals.decide(input.id, input.allow);
          return { ok: true };
        }),
      );
    });
  },
};

export default plugin;
