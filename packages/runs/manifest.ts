import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:runs', title: 'Runs', description: 'Run lifecycle', required: true,
  inject: ['harnessState', 'harnessRoutes', 'harnessRegistry', 'harnessPi', 'harnessSettings'], provides: ['harnessRuns'], setup,
};
