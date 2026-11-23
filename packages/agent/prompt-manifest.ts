import type { PluginDescriptor } from '../contracts/plugins.js';
import type { ScopedPromptSection } from '../contracts/events.js';
import { Prompt } from './prompt.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:prompt', title: 'Prompt', description: 'System prompt sections and workspace instructions', required: true,
  inject: ['harnessState'], provides: ['harnessPrompt'],
  setup(ctx) {
    ctx.provide('harnessPrompt', new Prompt(ctx.harnessState.paths.home,
      (id) => {
        const sections: ScopedPromptSection[] = [];
        ctx.emit('harness/prompt-sections', id, sections);
        return sections;
      }));
  }
};
