import type { PluginMetadata } from '@mini-harness/contracts/plugins';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { RemoteStore } from '@mini-harness/web/models/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(() => api.request<PluginMetadata[]>('/plugins'));
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('plugins', store));
  ctx.provide('miniPluginData', store);
};

declare module 'cordis' {
  interface Context { miniPluginData: RemoteStore<PluginMetadata[]> }
}

export default setup;
