import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Model transport',
  description: 'Native LLM streaming via the Pi adapter',
};

const plugin: Plugin.Object = {
  inject: ['harnessModelStore'],
  provide: ['harnessLlm'],
  apply(ctx) {
    ctx.provide('harnessLlm', ctx.harnessModelStore.llm);
  },
};

export default plugin;
