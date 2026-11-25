import type {} from 'mini-harness/cordis';
import type { Approval } from '../shared/request.js';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

declare module 'mini-harness/cordis' {
  interface Context {
    miniApprovals: RemoteStore<Approval[]>;
  }
}
