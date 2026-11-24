import type {} from 'cordis';
import type { ProjectionNotice } from '@mini-harness/ui-runtime/projection-notice';

export type ChangesListener = (notice: ProjectionNotice) => void;

export interface ProjectionPort {
  register(domain: string): () => void;
  invalidate(domain: string, scope?: { sessionId?: string; workspaceId?: string }): void;
  snapshot(): ProjectionNotice;
  subscribe(listener: ChangesListener): () => void;
}

declare module 'cordis' {
  interface Context { harnessChanges: ProjectionPort }
}
