import type { ProjectionNotice } from './shared/projection-notice.ts';

export type ChangesListener = (notice: ProjectionNotice) => void;

export interface ProjectionPort {
  register(domain: string): () => void;
  invalidate(domain: string, scope?: { sessionId?: string; workspaceId?: string }): void;
  snapshot(): ProjectionNotice;
  subscribe(listener: ChangesListener): () => void;
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessChanges: ProjectionPort;
  }
}
