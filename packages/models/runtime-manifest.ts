import type { PluginDescriptor } from '../contracts/plugins.js';
import { PiModelAdapter } from './pi-adapter.js';

export const manifest: PluginDescriptor = {
  id: 'core:model-runtime', scope: 'application', required: true,
  title: 'Model runtime', description: 'Model catalog, credentials and the Pi transport adapter',
  inject: ['harnessState', 'harnessSettingsStore'], provides: ['harnessLlm', 'harnessModels', 'harnessModelAdmin'],
  async setup(ctx) {
    const adapter = new PiModelAdapter(ctx.harnessState.paths.home);
    await adapter.refresh();
    ctx.provide('harnessLlm', adapter);
    ctx.provide('harnessModels', adapter);
    ctx.provide('harnessModelAdmin', adapter);
    ctx.effect(() => ctx.harnessSettingsStore.validate((next) => { adapter.resolve(next.model); }));
    ctx.effect(() => () => adapter.close());
  }
};
