import type { PluginDescriptor } from '../contracts/plugins.js';
import { PiModelStore } from './pi-adapter.js';

declare module 'cordis' {
  interface Context { harnessModelStore: PiModelStore }
}

export const manifest: PluginDescriptor = {
  id: 'core:model-store', scope: 'application', required: true,
  title: 'Model store', description: 'Shared provider definitions and credentials',
  inject: ['harnessState'], provides: ['harnessModelStore'],
  async setup(ctx) {
    const store = new PiModelStore(ctx.harnessState.paths.home);
    await store.refresh();
    ctx.provide('harnessModelStore', store);
    ctx.effect(() => () => store.close());
  }
};
