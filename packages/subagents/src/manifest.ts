import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';
import { childLimits } from './shared/limits.ts';

/** One self-contained plugin schema. Changes to child limits are safe during active runs. */
const Config = defineConfig({
  ...Type.Object(
    {
      maxDepth: Type.Integer(childLimits.maxDepth),
      maxParallel: Type.Integer(childLimits.maxParallel),
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
        { default: null },
      ),
    },
    { additionalProperties: false },
  ),
});

export const metadata: PluginInfo = {
  title: 'Subagents',
  description: 'Delegate tasks to child conversations.',
  icon: 'delegate',
  browser: 'packages/subagents/src/browser/setup.js',
  browserStyles: ['packages/subagents/src/browser/style.css'],
};

const plugin: Plugin.Object = {
  Config,
  inject: ['harnessTools', 'harnessSessions', 'harnessModels', 'harnessRuns', 'harnessTasks'],
  apply: setup,
};

export default plugin;
