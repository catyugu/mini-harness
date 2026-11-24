import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniProjections', 'miniSettingsData', 'miniPages', 'miniSwitch', 'miniBrowserFailures', 'miniModels', 'miniDialogs', 'miniSlots'],
  id: 'core:plugins', title: 'Plugins', description: 'Plugin management', required: true,
  inject: ['harnessPluginCatalog', 'harnessSettingsStore', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browser: '/packages/plugins/browser.js',
};
