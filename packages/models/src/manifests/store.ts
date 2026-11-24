import type {} from '@mini-harness/platform/runtime-paths';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { PiModelStore } from '../server/pi-adapter.js';

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
