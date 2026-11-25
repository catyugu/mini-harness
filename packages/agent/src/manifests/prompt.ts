import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { Service, type Plugin } from 'mini-harness/cordis';
import { Prompt } from '../prompt.ts';

export const metadata: PluginInfo = {
  title: 'Prompt',
  description: 'System prompt sections and workspace instructions',
};

const plugin: Plugin.Object = {
  inject: ['harnessState'],
  provide: ['harnessPrompt'],
  apply(ctx) {
    ctx.provide('harnessPrompt', Service.track(new Prompt(ctx.harnessState.paths.home)));
  },
};

export default plugin;
