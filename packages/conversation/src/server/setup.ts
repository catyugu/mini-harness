import type { ConversationView } from '../shared/api.ts';
import type { Context } from 'mini-harness/cordis';
import { projectHistory, projectToolEvent } from './display-events.ts';
import { projectSession } from './navigation.ts';
import { registerSessionRoutes } from './routes.ts';

export function setup(ctx: Context) {
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('sessions'));
  ctx.effect(() => changes.register('queue'));
  ctx.effect(() => changes.register('conversation-records'));
  const track = (source: EventTarget, domain: (event: CustomEvent) => string) => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const resourceId = event.detail.id;
      changes.invalidate(domain(event), resourceId);
      if (event.detail.record) changes.invalidate('conversation-records', resourceId);
    };
    ctx.effect(() => {
      source.addEventListener('change', listener);
      return () => source.removeEventListener('change', listener);
    });
  };
  track(ctx.harnessSessions.events, (event) => (event.detail.queue ? 'queue' : 'sessions'));
  track(ctx.harnessRuns.events, () => 'sessions');
  track(ctx.harnessApprovals.events, () => 'sessions');
  registerSessionRoutes(ctx, (id): ConversationView => {
    const { harnessSessions: sessions, harnessRuns } = ctx;
    const record = sessions.assertAvailable(id);
    const history = harnessRuns.history(id);
    const { partial, tools, records } = harnessRuns.activity(id);
    return {
      ...projectSession(ctx, record),
      timeline: projectHistory(ctx, id, history?.timeline ?? []),
      leafId: history?.leafId ?? null,
      model: history?.model,
      thinkingLevel: history?.thinkingLevel,
      queue: sessions.inspectLog(id, (log) => log.queue()) ?? [],
      partial,
      records,
      tools: tools.map((tool) => projectToolEvent(ctx, id, tool)),
      logError: sessions.logError(id),
    };
  });
}
