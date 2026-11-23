import type { Approval } from '../../contracts/approval.js';
import type { FrontendSetup } from '../../ui-runtime/frontend.js';
import { RemoteStore } from '../../web/models/remote-store.js';

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
