import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { PiLlm } from './pi-adapter.js';

export const manifest: PluginDescriptor = {
  id: 'core:llm', scope: 'application', required: true,
  title: 'Model transport', description: 'Native LLM streaming via the Pi adapter',
  inject: ['harnessModelStore'], provides: ['harnessLlm'],
  setup(ctx) {
    ctx.provide('harnessLlm', new PiLlm(ctx.harnessModelStore));
  }
};
