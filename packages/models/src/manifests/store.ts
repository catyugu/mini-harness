import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { ModelStore } from '../server/store.ts';

export const metadata: PluginInfo = {
  title: 'Model store',
  description: 'Shared provider definitions and credentials',
};

const plugin: Plugin.Object = {
  inject: ['harnessState', 'harnessModels'],
  provide: ['harnessModelStore'],
  async apply(ctx) {
    const store = new ModelStore(ctx.harnessState.paths.home);
    ctx.effect(() => () => store.close());
    await store.refresh();
    ctx.provide('harnessModelStore', store);
    ctx.effect(() => ctx.harnessModels.register(store, -1));
  },
};

export default plugin;
