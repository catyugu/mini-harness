import type {} from 'cordis';
import type { WorkspaceRecord } from '../shared/record.js';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

declare module 'cordis' {
  interface Context { miniWorkspaces: RemoteStore<WorkspaceRecord[]> }
}
