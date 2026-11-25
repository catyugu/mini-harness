import type { WorkspaceRecord } from '../shared/record.js';
import type {} from 'mini-harness/cordis';

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
  beforeRemove(handler: (id: string) => Promise<string[]>): () => void;
  browse(path: string): {
    path: string;
    parent: string | null;
    directories: { name: string; path: string }[];
  };
}

declare module 'mini-harness/cordis' {
  interface Context {
    harnessWorkspaces: WorkspacePort;
  }
}
