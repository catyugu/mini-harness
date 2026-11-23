import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';
import { setup } from './host.js';
import { Type } from 'typebox';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:agent', title: 'Agent', description: 'Native agent execution, inbox and tool pipeline', required: true,
  optional: ['harnessSkills'],
  configSchema: Type.Object({
    maxTurns: Type.Integer({ minimum: 1, maximum: 1024, default: 128, title: 'Maximum turns per run' }),
    autoCompact: Type.Boolean({ default: true, title: 'Automatically compact long conversations' })
  }, { additionalProperties: false }),
  inject: ['harnessScopes', 'harnessRoutes', 'harnessRegistry', 'harnessSettingsStore', 'harnessTools', 'harnessModels', 'harnessLlm', 'harnessPrompt'],
  provides: ['harnessAgent'], setup,
};
