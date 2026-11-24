import type {} from 'mini-harness/cordis';
import type { WorkspaceRecord } from '../shared/record.js';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

declare module 'mini-harness/cordis' {
  interface Context { miniWorkspaces: RemoteStore<WorkspaceRecord[]> }
}
