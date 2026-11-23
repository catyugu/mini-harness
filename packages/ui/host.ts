import type { Context } from 'cordis';
import { projectionDomains, type ProjectionDomain, type ProjectionNotice } from '@mini-harness/contracts/navigation';
import { eventStream } from '@mini-harness/transport/http';

export function setup(ctx: Context) {
  const revisions = new Map<ProjectionDomain, number>(projectionDomains.map((domain) => [domain, 0]));
  const listeners = new Set<(notice: ProjectionNotice) => void>();
  const mark = (domain: ProjectionDomain, sessionId?: string, workspaceId?: string) => {
    const revision = (revisions.get(domain) ?? 0) + 1;
    revisions.set(domain, revision);
    const notice: ProjectionNotice = { type: 'change', domain, revision, sessionId, workspaceId };
    for (const send of listeners) send(notice);
  };
  const listen = (source: EventTarget, callback: (event: Event) => void) =>
    ctx.effect(() => {
      source.addEventListener('change', callback);
      return () => source.removeEventListener('change', callback);
    });

  listen(ctx.harnessRegistry.events, (event) => {
    if (!(event instanceof CustomEvent)) return;
    if (event.detail.queue) mark('queue', event.detail.id);
    else mark('sessions', event.detail.id);
  });
  listen(ctx.harnessRuns.events, (event) => {
    if (event instanceof CustomEvent) mark('sessions', event.detail.id);
  });
  listen(ctx.harnessApprovals.events, (event) => {
    if (!(event instanceof CustomEvent)) return;
    mark('approvals', event.detail.id);
    mark('sessions', event.detail.id);
  });
  listen(ctx.harnessWorkspaces.events, () => mark('workspaces'));
  listen(ctx.harnessChanges, (event) => {
    if (event instanceof CustomEvent) mark(event.detail.domain, event.detail.sessionId, event.detail.workspaceId);
  });

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
    send({ type: 'snapshot', revisions: Object.fromEntries(revisions) });
  }));
}
