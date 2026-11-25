import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  id: 'core:llm',
  scope: 'application',
  defaultEnabled: true,
  title: 'Model transport',
  description: 'Native LLM streaming via the Pi adapter',

  plugin: {
    inject: ['harnessModelStore'],
    provide: ['harnessLlm'],
    apply(ctx) {
      ctx.provide('harnessLlm', ctx.harnessModelStore.llm);
    },
  },
};
