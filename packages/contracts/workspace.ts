import type {} from 'cordis';

export interface WorkspaceRecord { id: string; path: string; name: string }

export interface WorkspacePort {
  readonly events: EventTarget;
  readonly defaultId: string | undefined;
  list(): WorkspaceRecord[];
  get(id: string): WorkspaceRecord;
  resolveRoot(root: string, id: string): string;
  register(path: string, name?: string): WorkspaceRecord;
  rename(id: string, name: string): WorkspaceRecord;
  reorder(ids: string[]): WorkspaceRecord[];
  remove(id: string): void;
  browse(path: string): { path: string; parent: string | null; directories: { name: string; path: string }[] };
}

declare module 'cordis' {
  interface Context { harnessWorkspaces: WorkspacePort }
}

export const workspaceRoute = (id: string, resource = '') => '/workspaces/' + encodeURIComponent(id) + resource;
