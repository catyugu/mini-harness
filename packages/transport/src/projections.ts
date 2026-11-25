import type { ProjectionNotice } from './shared/projection-notice.ts';

import type { ChangesListener, ProjectionPort } from './projection-api.ts';

export class ProjectionChanges implements ProjectionPort {
  private readonly domains = new Map<string, { mounts: number; revision: number }>();
  private readonly listeners = new Set<ChangesListener>();

  register(domain: string) {
    let state = this.domains.get(domain);
    if (!state) this.domains.set(domain, (state = { mounts: 0, revision: 0 }));
    state.mounts++;
    const registered = state;
    return () => {
      registered.mounts--;
    };
  }

  invalidate(domain: string, resourceId?: string) {
    const state = this.domains.get(domain);
    if (!state?.mounts) return;
    const notice: ProjectionNotice = { type: 'change', domain, revision: ++state.revision, resourceId };
    for (const send of this.listeners) send(notice);
  }

  snapshot(): ProjectionNotice {
    return {
      type: 'snapshot',
      revisions: Object.fromEntries([...this.domains].map(([domain, { revision }]) => [domain, revision])),
    };
  }

  subscribe(listener: ChangesListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
