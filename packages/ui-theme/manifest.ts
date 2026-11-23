import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  browserInject: ['miniSettingsData'],
  id: 'core:theme', title: 'Theme', description: 'Application theme', required: true,
  browser: '/packages/ui-theme/browser.js', browserRequires: [],
};
