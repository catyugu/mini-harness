import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSettings', 'miniModels'],
  id: 'core:models', title: 'Models', description: 'Model endpoints and credentials', required: true,
  optional: ['harnessDelegation'],
  inject: ['harnessAgent', 'harnessModels', 'harnessModelAdmin', 'harnessRuns', 'harnessUpdateSettings', 'harnessSettings', 'harnessSettingsStore', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browser: '/packages/models/browser.js', browserRequires: ['core:settings'],
};
