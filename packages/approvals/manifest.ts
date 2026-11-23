import type { PluginDescriptor } from '../contracts/plugins.js';
import { Approvals } from './approvals.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:approvals', title: 'Approvals', description: 'Pending user decisions', required: true,
  inject: ['harnessRoutes'], provides: ['harnessApprovals'],
  setup(ctx) {
    const approvals = new Approvals();
    ctx.provide('harnessApprovals', approvals);
    ctx.effect(() => () => approvals.close());
    ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/approvals', () => approvals.list()));
    ctx.effect(() => ctx.harnessRoutes.register('POST', '/api/approvals', async ({ body }) => {
      const input = await body() as { id?: string; allow?: boolean } | null;
      if (typeof input?.id !== 'string' || typeof input.allow !== 'boolean') throw new Error('Choose allow or deny');
      approvals.decide(input.id, input.allow);
      return { ok: true };
    }));
  }
};
