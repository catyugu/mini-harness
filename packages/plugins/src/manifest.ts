import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniProjections', 'miniSettingsData', 'miniSettingsRegistry', 'miniPages', 'miniSwitch', 'miniBrowserFailures', 'miniModels', 'miniDialogs', 'miniSlots'],
  id: 'core:plugins', title: 'Plugins', description: 'Plugin management', defaultEnabled: true,
  inject: ['harnessPluginCatalog', 'harnessSettingsStore', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browserStyles: ['/packages/plugins/src/browser/style.css'],
  browser: '/packages/plugins/src/browser/setup.js',
};
