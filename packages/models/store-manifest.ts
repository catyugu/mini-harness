import type {} from '@mini-harness/platform/runtime-paths';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
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
    ctx.effect(() => () => store.close());
    await store.refresh();
    ctx.provide('harnessModelStore', store);
  }
};
