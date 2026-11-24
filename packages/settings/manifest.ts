import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniSettings', 'miniSettingsData', 'miniSettingsRegistry'],
  browserInject: ['miniLayout', 'miniSlots', 'miniProjections'],
  id: 'core:settings', title: 'Settings', description: 'Application settings', required: true,
  inject: ['harnessChanges', 'harnessSettingsStore', 'harnessRoutes', 'harnessMutations'], provides: [], setup,
  browser: '/packages/settings/browser.js',
};
