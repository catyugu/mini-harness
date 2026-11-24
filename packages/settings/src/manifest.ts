import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniSettings', 'miniSettingsData', 'miniSettingsRegistry'],
  browserInject: ['miniLayout', 'miniSlots', 'miniProjections', 'miniAppearance'],
  id: 'core:settings', title: 'Settings', description: 'Application settings', defaultEnabled: true,
    plugin: {
                                                                                                           inject: ['harnessChanges', 'harnessSettingsStore', 'harnessRoutes', 'harnessMutations'],
                                                                                                           provide: [],
                                                                                                           apply: setup
                                                                                                         },
  browserStyles: ['/packages/settings/src/browser/style.css'],
  browser: '/packages/settings/src/browser/setup.js',
};
