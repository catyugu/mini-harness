import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../setup.js';
import { Type } from 'typebox';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:agent', title: 'Agent', description: 'Native agent execution, inbox and tool pipeline', required: true,
  configSchema: Type.Object({
    maxTurns: Type.Integer({ minimum: 1, maximum: 1024, default: 128, title: 'Maximum turns per run' }),
    autoCompact: Type.Boolean({ default: true, title: 'Automatically compact long conversations' })
  }, { additionalProperties: false }),
  inject: ['harnessScopes', 'harnessMutations', 'harnessRoutes', 'harnessRegistry', 'harnessTools', 'harnessModels', 'harnessLlm', 'harnessPrompt'],
  provides: ['harnessAgent'], setup,
};
