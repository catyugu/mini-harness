import type { Approval } from '@mini-harness/contracts/approval';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { RemoteStore } from '@mini-harness/web/models/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(() => api.request<Approval[]>('/approvals'));
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('approvals', store));
  ctx.provide('miniApprovals', store);
};

declare module 'cordis' {
  interface Context { miniApprovals: RemoteStore<Approval[]> }
}

export default setup;
