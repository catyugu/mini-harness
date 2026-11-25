import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';

/** One self-contained plugin schema. Changes to child limits are safe during active runs. */
export const manifest: PluginDescriptor = {
  scope: 'application',
  plugin: {
    inject: ['harnessTools', 'harnessSessions', 'harnessModels', 'harnessExecution'],
    apply: setup,
  },
  defaultEnabled: true,
  configChanges: 'live',
  id: 'subagents',
  title: 'Subagents',
  description: 'Delegate tasks to child conversations.',
  icon: 'delegate',
  browser: '/packages/subagents/src/browser/setup.js',
  configGroups: [
    { title: 'Run limits', fields: ['maxDepth', 'maxParallel'] },
    { title: 'Model selection', fields: ['model'] },
  ],
  configSchema: {
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
  },
  validateConfig({ model }, { service }) {
    if (
      model &&
      !service('harnessModels').resolve(model as import('@mini-harness/llm/vocabulary').ModelChoice)
    ) {
      const { provider, id } = model as import('@mini-harness/llm/vocabulary').ModelChoice;
      throw new DomainError('invalid_input', 'Unknown child model: ' + provider + '/' + id);
    }
  },
};
