import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:plugins', title: 'Plugins', description: 'Plugin management', required: true,
  inject: ['harnessPluginCatalog', 'harnessSettingsStore', 'harnessState', 'harnessSettings', 'harnessRoutes', 'harnessMutations', 'harnessChanges'], provides: [], setup,
  browser: '/packages/plugins/browser.js', browserRequires: ['core:layout'],
};
