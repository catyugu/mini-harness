import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';

/** One self-contained plugin schema. Changes to child limits are safe during active runs. */
const Config = defineConfig({
  ...Type.Object(
    {
      maxDepth: Type.Integer({ title: 'Maximum child depth', minimum: 0, maximum: 8, default: 1 }),
      maxParallel: Type.Integer({ title: 'Parallel children', minimum: 1, maximum: 16, default: 4 }),
      model: Type.Union(
        [
          Type.Null(),
          Type.Object(
            {
              provider: Type.String({ minLength: 1, maxLength: 160 }),
              id: Type.String({ minLength: 1, maxLength: 160 }),
            },
            { additionalProperties: false },
          ),
        ],
        { title: 'Child model', default: null, 'x-modelChoice': true },
      ),
    },
    { additionalProperties: false },
  ),
});

export const metadata: PluginInfo = {
  title: 'Subagents',
  description: 'Delegate tasks to child conversations.',
  icon: 'delegate',
  browser: '/packages/subagents/src/browser/setup.js',
  configGroups: [
    { title: 'Run limits', fields: ['maxDepth', 'maxParallel'] },
    { title: 'Model selection', fields: ['model'] },
  ],
};

const plugin: Plugin.Object = {
  Config,
  inject: ['harnessTools', 'harnessSessions', 'harnessModels', 'harnessExecution'],
  apply: setup,
};

export default plugin;
