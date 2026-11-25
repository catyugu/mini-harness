import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { defineConfig } from '@mini-harness/plugin-api/configuration';
import { Type } from 'typebox';
import { setup } from './setup.ts';

export const metadata: PluginInfo = {
  title: 'Runs',
  description: 'Run lifecycle',
};

const plugin: Plugin.Object = {
  Config: defineConfig(
    Type.Object(
      {
        autoCompact: Type.Boolean({ default: true, title: 'Automatically compact long conversations' }),
      },
      { additionalProperties: false },
    ),
  ),
  inject: [
    'harnessProfileScopes',
    'harnessSessions',
    'harnessAgent',
    'harnessModels',
    'harnessPrompt',
    'harnessTools',
    'harnessToolExecutor',
  ],
  provide: ['harnessRuns', 'harnessExecution'],
  apply: setup,
};

export default plugin;
