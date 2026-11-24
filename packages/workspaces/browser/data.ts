import type {} from '@mini-harness/ui-runtime/projection-api';
import type { WorkspaceRecord } from '../api.js';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(() => api.request<WorkspaceRecord[]>('/workspaces'));
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('workspaces', store));
  ctx.provide('miniWorkspaces', store);
};

export default setup;
