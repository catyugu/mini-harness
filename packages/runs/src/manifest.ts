import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:runs', title: 'Runs', description: 'Run lifecycle', required: true,
  inject: ['harnessScopes', 'harnessRoutes', 'harnessRegistry', 'harnessMutations', 'harnessAgent'], provides: ['harnessRuns', 'harnessExecution'], setup,
};
