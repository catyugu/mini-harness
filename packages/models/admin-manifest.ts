import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  id: 'core:model-admin', scope: 'application', required: true,
  title: 'Model administration', description: 'Provider and credential management',
  inject: ['harnessModelStore'], provides: ['harnessModelAdmin'],
  setup(ctx) {
    const store = ctx.harnessModelStore;
    ctx.provide('harnessModelAdmin', {
      providers: () => store.providers(),
      authStatus: (id) => store.authStatus(id),
      hasProvider: (id) => store.hasProvider(id),
      refresh: () => store.refresh(),
      storeCredential: (id, key) => store.storeCredential(id, key),
      removeCredential: (id) => store.removeCredential(id)
    });
  }
};
