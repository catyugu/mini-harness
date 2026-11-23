import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniProjections', 'miniSettingsData', 'miniPages', 'miniSwitch', 'miniBrowserFailures', 'miniModels'], browserProvides: ['miniPluginData'],
  id: 'core:plugins', title: 'Plugins', description: 'Plugin management', required: true,
  inject: ['harnessPluginCatalog', 'harnessSettingsStore', 'harnessState', 'harnessSettings', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browser: '/packages/plugins/browser.js', browserRequires: ['core:layout', 'core:models'],
};
