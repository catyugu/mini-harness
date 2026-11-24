import type { WorkspaceRecord } from '../shared/record.js';
import type {} from 'cordis';

export interface WorkspacePort {
  readonly events: EventTarget;
  readonly defaultId: string | undefined;
  list(): WorkspaceRecord[];
  get(id: string): WorkspaceRecord;
  resolveRoot(root: string, id: string): string;
  register(path: string, name?: string): WorkspaceRecord;
  rename(id: string, name: string): WorkspaceRecord;
  reorder(ids: string[]): WorkspaceRecord[];
  assertAvailable(id: string): void;
  beforeRemove(participant: (id: string) => Promise<string[]>): () => void;
  remove(id: string): Promise<{ removed: string; deleted: string[] }>;
  browse(path: string): { path: string; parent: string | null; directories: { name: string; path: string }[] };
}

/** Read-only workspace lookup; identity mutation remains an application operation. */
export type WorkspaceAccess = Pick<WorkspacePort, 'list' | 'get' | 'resolveRoot' | 'defaultId'>;
declare module '@mini-harness/kernel/services' {
  interface ServiceMap { harnessWorkspaces: WorkspaceAccess }
}

declare module 'cordis' {
  interface Context { harnessWorkspaces: WorkspacePort }
}
