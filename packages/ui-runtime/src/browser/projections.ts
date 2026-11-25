import type { ProjectionNotice } from '@mini-harness/transport/projection-notice';
import type { BrowserProjection, BrowserProjectionPort } from './projection-api.js';

/** Features own snapshots; the runtime only routes invalidation notices to live owners. */
export class BrowserProjections implements BrowserProjectionPort {
  private readonly subscribers = new Map<
    string,
    Set<{ projection: BrowserProjection; active: boolean; failed: boolean }>
  >();

  constructor(private readonly report: (domain: string, error: unknown) => void = () => {}) {}

  register(domain: string, projection: BrowserProjection) {
    let listeners = this.subscribers.get(domain);
    if (!listeners) this.subscribers.set(domain, (listeners = new Set()));
    const lease = { projection, active: true, failed: false };
    listeners.add(lease);
    return () => {
      lease.active = false;
      listeners.delete(lease);
      if (!listeners.size) this.subscribers.delete(domain);
    };
  }

  async dispatch(event: ProjectionNotice) {
    const updates: Promise<void>[] = [];
    for (const [domain, listeners] of this.subscribers) {
      if (event.type === 'change' && event.domain !== domain) continue;
      const revision =
        event.type === 'change'
          ? event.revision
          : Object.hasOwn(event.revisions, domain)
            ? (event.revisions[domain] ?? 0)
            : 0;
      for (const lease of [...listeners])
        updates.push(
          Promise.resolve().then(async () => {
            if (!lease.active) return;
            try {
              await lease.projection.sync(
                revision,
                event.type === 'snapshot',
                event.type === 'change' ? (event.sessionId ?? event.workspaceId) : undefined,
              );
              lease.failed = false;
            } catch (error) {
              if (lease.active && !lease.failed) this.report(domain, error);
              lease.failed = true;
            }
          }),
        );
    }
    await Promise.allSettled(updates);
  }
}
