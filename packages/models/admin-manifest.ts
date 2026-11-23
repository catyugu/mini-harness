import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';
import type { ModelAdminPort } from '#mini-harness/contracts/models.js';

export const manifest: PluginDescriptor = {
  id: 'core:model-admin', scope: 'application', required: true,
  title: 'Model administration', description: 'Provider and credential management',
  inject: ['harnessModelStore'], provides: ['harnessModelAdmin'],
  setup(ctx) {
    const store = ctx.harnessModelStore;
    const admin: ModelAdminPort = {
      providers: () => store.providers(),
      authStatus: (id) => store.authStatus(id),
      hasProvider: (id) => store.hasProvider(id),
      refresh: () => store.refresh(),
      storeCredential: (id, key) => store.storeCredential(id, key),
      removeCredential: (id) => store.removeCredential(id)
    };
    ctx.provide('harnessModelAdmin', admin);
  }
};
