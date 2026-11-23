import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:settings-data', title: 'Settings data',
  description: 'Live settings projection', required: true,
  browserInject: ['miniProjections'], browserProvides: ['miniSettingsData'],
  browser: '/packages/settings/browser/data.js'
};
