import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  browserInject: ['miniSettings', 'miniModels'],
  id: 'core:models', title: 'Models', description: 'Pi model endpoints and credentials', required: true,
  optional: ['harnessDelegation'],
  inject: ['harnessPi', 'harnessModels', 'harnessModelAdmin', 'harnessRuns', 'harnessUpdateSettings', 'harnessSettings', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browser: '/packages/models/browser.js', browserRequires: ['core:settings'],
};
