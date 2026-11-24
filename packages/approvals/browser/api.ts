import type {} from 'cordis';
import type { Approval } from '../api.js';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

declare module 'cordis' {
  interface Context { miniApprovals: RemoteStore<Approval[]> }
}
