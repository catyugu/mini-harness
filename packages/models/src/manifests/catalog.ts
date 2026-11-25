import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Model catalog',
  description: 'Model discovery and capabilities',
};

const plugin: Plugin.Object = {
  inject: ['harnessModelStore'],
  provide: ['harnessModels'],
  apply(ctx) {
    const store = ctx.harnessModelStore;
    ctx.provide('harnessModels', {
      list: () => store.list(),
      available: () => store.available(),
      resolve: (choice) => store.resolve(choice),
      capabilities: (choice) => store.capabilities(choice),
      connection: (choice) => store.connection(choice),
      apiKey: (choice) => store.apiKey(choice),
    });
  },
};

export default plugin;
