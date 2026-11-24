import type { Settings } from '@mini-harness/contracts/config';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';

const setup: FrontendSetup = async (ctx, api) => {
  const store = new RemoteStore(() => api.request<Settings>('/settings'));
  await store.refresh();
  api.onDispose(ctx.miniProjections.register('settings', store));
  ctx.provide('miniSettingsData', store);
};

declare module 'cordis' {
  interface Context { miniSettingsData: RemoteStore<Settings> }
}

export default setup;
