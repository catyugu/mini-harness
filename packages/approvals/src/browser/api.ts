import type { Approval } from '../shared/request.ts';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

declare module 'mini-harness/cordis' {
  interface Context {
    miniApprovals: RemoteStore<Approval[]>;
  }
}
