import type { BuiltinPlugin } from '../../src/contracts/plugins.js';
import { Type } from 'typebox';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'subagents', title: 'Subagents', description: 'Delegate tasks to child conversations.',
  preferences: { key: 'subagents', groups: [
    { title: 'Run limits', fields: ['maxDepth', 'maxParallel'] },
    { title: 'Model selection', fields: ['provider', 'model'] }
  ], schema: { ...Type.Object({
    maxDepth: Type.Integer({ title: 'Maximum child depth', minimum: 0, maximum: 8 }),
    maxParallel: Type.Integer({ title: 'Parallel children', minimum: 1, maximum: 16 }),
    provider: Type.Optional(Type.String({ title: 'Child provider' })),
    model: Type.Optional(Type.String({ title: 'Child model' }))
  }) } },
  icon: 'delegate', browser: '/features/subagents/client.js', inject: ['harnessTools', 'harnessRegistry', 'harnessPi', 'harnessRuns', 'harnessSettings', 'harnessSettingsStore', 'harnessOperations'],
};
