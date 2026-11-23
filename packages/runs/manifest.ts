import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:runs', title: 'Runs', description: 'Run lifecycle', required: true,
  inject: ['harnessState', 'harnessRoutes', 'harnessRegistry', 'harnessPi', 'harnessModels', 'harnessSettings'], provides: ['harnessRuns'], setup,
};
