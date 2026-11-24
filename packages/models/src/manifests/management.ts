import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:model-management', title: 'Models', description: 'Model endpoints and credentials', required: true,
  inject: ['harnessModels', 'harnessModelStore', 'harnessModelPreference', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  browserInject: ['miniSettings', 'miniProjections', 'miniSettingsRegistry'], browserProvides: ['miniModels'],
  setup,
  browserStyles: ['/packages/models/src/browser/style.css'],
  browser: '/packages/models/src/browser/setup.js',
};
