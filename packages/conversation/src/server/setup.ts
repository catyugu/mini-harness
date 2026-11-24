import type {} from '@mini-harness/transport/projection-api';
import type {} from '@mini-harness/sessions/store';
import type {} from '@mini-harness/runs/api';
import type {} from '@mini-harness/approvals/api';
import type {} from '@mini-harness/models/api';
import type { ConversationView } from '../shared/api.js';
import type { Context } from 'cordis';
import { projectHistory, projectToolEvent } from './display-extensions.js';
import { projectSession } from './navigation.js';
import { registerSessionRoutes } from './routes.js';

export function setup(ctx: Context) {
  const changes = ctx.harnessChanges;
  ctx.effect(() => changes.register('sessions'));
  ctx.effect(() => changes.register('queue'));
  ctx.effect(() => changes.register('conversation-records'));
  const track = (source: EventTarget, domain: (event: CustomEvent) => string) => {
    const listener = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const scope = { sessionId: event.detail.id };
      changes.invalidate(domain(event), scope);
      if (event.detail.records) changes.invalidate('conversation-records', scope);
    };
    ctx.effect(() => {
      source.addEventListener('change', listener);
      return () => source.removeEventListener('change', listener);
    });
  };
  track(ctx.harnessRegistry.events, (event) => event.detail.queue ? 'queue' : 'sessions');
  track(ctx.harnessRuns.events, () => 'sessions');
  track(ctx.harnessApprovals.events, () => 'sessions');
  registerSessionRoutes(ctx, (id): ConversationView => {
    const record = ctx.harnessRegistry.get(id);
    if (!record) throw new Error('Conversation not found');
    const { harnessRegistry: sessions, harnessRuns } = ctx;
    sessions.assertAvailable(id);
    const history = sessions.inspectLog(id, (log) => ({ ...log.projection(), queue: log.queue() }));
    const { partial, tools } = harnessRuns.activity(id);
    return { ...projectSession(ctx, record),
      messages: projectHistory(ctx, id, history?.messages ?? []), leafId: history?.leafId ?? null,
      records: history?.records ?? [],
      model: history?.model, thinkingLevel: history?.thinkingLevel,
      queue: history?.queue ?? [], partial, tools: tools.map((tool) => projectToolEvent(ctx, id, tool)),
      logError: sessions.logError(id) };
  });
}
