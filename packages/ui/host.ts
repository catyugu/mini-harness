import type { Context } from 'cordis';
import { projectionDomains, type ProjectionDomain, type ProjectionNotice } from '@mini-harness/contracts/navigation';
import { eventStream } from '@mini-harness/transport/http';

export function setup(ctx: Context) {
  const revisions = Object.fromEntries(projectionDomains.map((domain) => [domain, 0])) as Record<ProjectionDomain, number>;
  const listeners = new Set<(notice: ProjectionNotice) => void>();
  const mark = (domain: ProjectionDomain, sessionId?: string) => {
    const notice: ProjectionNotice = { type: 'change', domain, revision: ++revisions[domain], sessionId };
    for (const send of listeners) send(notice);
  };
  const listen = (source: EventTarget, callback: (event: CustomEvent) => void) =>
    ctx.effect(() => {
      source.addEventListener('change', callback);
      return () => source.removeEventListener('change', callback);
    });

  listen(ctx.harnessRegistry.events, ({ detail }) => mark('sessions', detail.id));
  listen(ctx.harnessRuns.events, ({ detail }) => mark('sessions', detail.id));
  listen(ctx.harnessApprovals.events, ({ detail }) => {
    mark('approvals', detail.id);
    mark('sessions', detail.id);
  });
  listen(ctx.harnessWorkspaces.events, () => mark('workspaces'));
  listen(ctx.harnessChanges, ({ detail }) => mark(detail.domain, detail.sessionId));

  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/bootstrap', () => ({
    ui: ctx.harnessPluginCatalog.browser()
  })));
  ctx.effect(() => ctx.harnessRoutes.register('GET', '/api/changes', ({ response }) => {
    const signal = ctx.get('harnessTransportSignal');
    signal?.throwIfAborted();
    const { send } = eventStream(response);
    const shutdown = () => response.end();
    signal?.addEventListener('abort', shutdown, { once: true });
    response.once('close', () => {
      listeners.delete(send);
      signal?.removeEventListener('abort', shutdown);
    });
    listeners.add(send);
    send({ type: 'snapshot', revisions });
  }));
}
