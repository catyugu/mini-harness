import type { ProjectionNotice } from '@mini-harness/contracts/navigation';
import type { BrowserProjection, BrowserProjectionPort } from '@mini-harness/contracts/browser';

/** Features own snapshots; the runtime only routes invalidation notices to live owners. */
export class BrowserProjections implements BrowserProjectionPort {
  private readonly subscribers = new Map<string, Set<{ projection: BrowserProjection; active: boolean }>>();

  register(domain: string, projection: BrowserProjection) {
    let listeners = this.subscribers.get(domain);
    if (!listeners) this.subscribers.set(domain, listeners = new Set());
    const lease = { projection, active: true };
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
      const revision = event.type === 'change' ? event.revision : event.revisions[domain] ?? 0;
      for (const lease of [...listeners]) updates.push(Promise.resolve().then(() => {
        if (lease.active) return lease.projection.sync(revision, event.type === 'snapshot', event.type === 'change' ? event.sessionId : undefined);
      }));
    }
    await Promise.all(updates);
  }
}
