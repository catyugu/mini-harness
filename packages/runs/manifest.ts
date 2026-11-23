import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:runs', title: 'Runs', description: 'Run lifecycle', required: true,
  inject: ['harnessScopes', 'harnessRoutes', 'harnessRegistry', 'harnessAgent'], provides: ['harnessRuns'], setup,
};
