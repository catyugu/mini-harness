import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../setup.ts';
import { Type } from 'typebox';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:agent',
  title: 'Agent',
  description: 'Native agent execution, inbox and tool pipeline',
  defaultEnabled: true,
  configSchema: Type.Object(
    {
      maxTurns: Type.Integer({ minimum: 1, maximum: 1024, default: 128, title: 'Maximum turns per run' }),
      autoCompact: Type.Boolean({ default: true, title: 'Automatically compact long conversations' }),
    },
    { additionalProperties: false },
  ),
  plugin: {
    inject: [
      'harnessScopes',
      'harnessRegistry',
      'harnessTools',
      'harnessModels',
      'harnessLlm',
      'harnessPrompt',
      'harnessToolExecutor',
    ],
    provide: ['harnessAgent'],
    apply: setup,
  },
};
