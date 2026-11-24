import type {} from '@mini-harness/platform/runtime-paths';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { Service } from 'mini-harness/cordis';
import { Prompt } from '../prompt.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:prompt', title: 'Prompt', description: 'System prompt sections and workspace instructions', defaultEnabled: true,

  plugin: {
    inject: ['harnessState'],
    provide: ['harnessPrompt'],
    apply(ctx) {
      ctx.provide('harnessPrompt', Service.track(new Prompt(ctx.harnessState.paths.home)));
    }
  }
};
