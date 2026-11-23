import type { PluginDescriptor } from '../contracts/plugins.js';
import { Prompt } from './prompt.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:prompt', title: 'Prompt', description: 'Workspace instructions and skill discovery', required: true,
  inject: ['harnessState', 'harnessScopes'], optional: ['harnessSkills'], provides: ['harnessPrompt'],
  setup(ctx) {
    ctx.provide('harnessPrompt', new Prompt(ctx.harnessState.paths.home,
      (id) => ctx.harnessScopes.resolve(id, 'harnessSkills') ?? ctx.get('harnessSkills')));
  }
};
