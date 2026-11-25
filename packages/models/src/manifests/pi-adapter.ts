import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { PiLlm } from '../server/pi-adapter.ts';

export const metadata: PluginInfo = {
  title: 'Pi model adapter',
  description: 'Model streaming via the Pi SDK',
};

const plugin: Plugin.Object = {
  inject: ['harnessModels', 'harnessLlm', 'harnessModelStore'],
  async apply(ctx) {
    const store = ctx.harnessModelStore;
    const adapter = new PiLlm(store);
    const removeDefaults = await adapter.registerModels();
    ctx.effect(() => removeDefaults);
    ctx.effect(() => ctx.harnessModels.register(store, adapter, -1));
  },
};

export default plugin;
