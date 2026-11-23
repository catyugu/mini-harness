import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:models', title: 'Models', description: 'Pi model endpoints and credentials', required: true,
  optional: ['harnessDelegation'],
  inject: ['harnessPi', 'harnessRuns', 'harnessUpdateSettings', 'harnessSettings', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browser: '/packages/models/browser.js', browserRequires: ['core:settings'],
};
