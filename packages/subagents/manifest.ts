import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';
import { Type } from 'typebox';

/** One self-contained plugin schema. Changes to child limits are safe during active runs. */
export const manifest: BuiltinPlugin = {
  setup, defaultEnabled: true, browserRequires: ['core:conversation'],
  configChanges: 'read-on-use',
  provides: ['harnessDelegation'],
  id: 'subagents', title: 'Subagents', description: 'Delegate tasks to child conversations.',
  icon: 'delegate', browser: '/packages/subagents/client.js',
  configGroups: [
    { title: 'Run limits', fields: ['maxDepth', 'maxParallel'] },
    { title: 'Model selection', fields: ['provider', 'model'] }
  ],
  configSchema: { ...Type.Object({
    maxDepth: Type.Integer({ title: 'Maximum child depth', minimum: 0, maximum: 8, default: 1 }),
    maxParallel: Type.Integer({ title: 'Parallel children', minimum: 1, maximum: 16, default: 4 }),
    provider: Type.String({ title: 'Child provider', maxLength: 160, default: '' }),
    model: Type.String({ title: 'Child model', maxLength: 160, default: '' })
  }, { additionalProperties: false }) },
  inject: ['harnessTools', 'harnessRegistry', 'harnessPi', 'harnessRuns', 'harnessSettingsStore']
};
