import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../setup.ts';
import { Type } from 'typebox';

const Config = defineConfig(
  Type.Object(
    {
      maxTurns: Type.Integer({ minimum: 1, maximum: 1024, default: 128, title: 'Maximum turns per run' }),
      autoCompact: Type.Boolean({ default: true, title: 'Automatically compact long conversations' }),
    },
    { additionalProperties: false },
  ),
);

export const metadata: PluginInfo = {
  title: 'Agent',
  description: 'Native agent execution, inbox and tool pipeline',
};

const plugin: Plugin.Object = {
  Config,
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
};

export default plugin;
