import type {} from '@mini-harness/ui-runtime/projection-api';
import type { Approval } from '../api.js';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(() => api.request<Approval[]>('/approvals'));
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('approvals', store));
  ctx.provide('miniApprovals', store);
};

export default setup;
