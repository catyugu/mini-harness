import type { PluginDescriptor } from '@mini-harness/contracts/plugins';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSettingsData'],
  id: 'core:theme', title: 'Theme', description: 'Application theme', required: true,
  browser: '/packages/ui-theme/browser.js', browserRequires: [],
};
