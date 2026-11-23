import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniSettings'],
  browserInject: ['miniSettingsRegistry', 'miniLayout'],
  id: 'core:settings', title: 'Settings', description: 'Application settings', required: true,
  inject: ['harnessSettings', 'harnessUpdateSettings', 'harnessWriteBrowserConfig', 'harnessRoutes', 'harnessMutations'], provides: [], setup,
  browser: '/packages/settings/browser.js', browserRequires: ['core:layout'],
};
