import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { Service, type Plugin } from 'mini-harness/cordis';
import { Prompt } from '../prompt.ts';

export const metadata: PluginInfo = {
  title: 'Prompt',
  description: 'System prompt composition',
};

const plugin: Plugin.Object = {
  provide: ['harnessPrompt'],
  apply(ctx) {
    ctx.provide('harnessPrompt', Service.track(new Prompt()));
  },
};

export default plugin;
