import type { WorkspaceRecord } from '@mini-harness/contracts/workspace';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(() => api.request<WorkspaceRecord[]>('/workspaces'));
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('workspaces', store));
  ctx.provide('miniWorkspaces', store);
};

declare module 'cordis' {
  interface Context { miniWorkspaces: RemoteStore<WorkspaceRecord[]> }
}

export default setup;
