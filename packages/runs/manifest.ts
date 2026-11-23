import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:runs', title: 'Runs', description: 'Run lifecycle', required: true,
  inject: ['harnessScopes', 'harnessRoutes', 'harnessRegistry', 'harnessMutations', 'harnessAgent'], provides: ['harnessRuns'], setup,
};
