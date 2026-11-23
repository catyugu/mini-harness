import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  id: 'core:model-catalog', scope: 'application', required: true,
  title: 'Model catalog', description: 'Model discovery and capabilities',
  inject: ['harnessModelStore'], provides: ['harnessModels'],
  setup(ctx) {
    const store = ctx.harnessModelStore;
    ctx.provide('harnessModels', {
      list: () => store.list(),
      available: () => store.available(),
      resolve: (choice) => store.resolve(choice),
      capabilities: (choice) => store.capabilities(choice)
    });
  }
};
