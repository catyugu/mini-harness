import type { Settings } from '../../contracts/config.js';
import type { FrontendSetup } from '../../ui-runtime/frontend.js';
import { RemoteStore } from '../../web/models/remote-store.js';

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
