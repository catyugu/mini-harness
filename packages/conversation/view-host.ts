import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/runs/api';
import type {} from '@mini-harness/approvals/api';
import type {} from '@mini-harness/agent/api';
import type { Context } from 'cordis';
import { projectSession } from './navigation.js';
import { registerSessionRoutes } from './routes.js';

export function setup(ctx: Context) {
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('sessions'));
  ctx.effect(() => changes.register('queue'));
  const track = (source: EventTarget, domain: (event: CustomEvent) => string) => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) changes.invalidate(domain(event), { sessionId: event.detail.id });
    };
    ctx.effect(() => {
      source.addEventListener('change', listener);
      return () => source.removeEventListener('change', listener);
    });
  };
  track(ctx.harnessRegistry.events, (event) => event.detail.queue ? 'queue' : 'sessions');
  track(ctx.harnessRuns.events, () => 'sessions');
  track(ctx.harnessApprovals.events, () => 'sessions');
  ctx.provide('harnessConversationView', {
    read(id) {
      const record = ctx.harnessRegistry.get(id);
      if (!record) throw new Error('Conversation not found');
      return { ...projectSession(ctx, record), ...ctx.harnessAgent.read(id),
        ...ctx.harnessRuns.activity(id), logError: ctx.harnessRegistry.logError(id) };
    }
  });
  registerSessionRoutes(ctx);
}
