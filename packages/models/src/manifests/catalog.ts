import type {} from '../server/store-api.js';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  id: 'core:model-catalog', scope: 'application', defaultEnabled: true,
  title: 'Model catalog', description: 'Model discovery and capabilities',

  plugin: {
    inject: ['harnessModelStore'],
    provide: ['harnessModels'],
    apply(ctx) {
      const store = ctx.harnessModelStore;
      ctx.provide('harnessModels', {
        list: () => store.list(),
        available: () => store.available(),
        resolve: (choice) => store.resolve(choice),
        capabilities: (choice) => store.capabilities(choice)
      });
    }
  }
};
