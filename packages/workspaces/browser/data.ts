import type { WorkspaceRecord } from '../../contracts/workspace.js';
import type { FrontendSetup } from '../../ui-runtime/frontend.js';
import { RemoteStore } from '../../web/models/remote-store.js';

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
