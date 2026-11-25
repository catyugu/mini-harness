import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:settings',
  title: 'Settings',
  description: 'Application settings',
  defaultEnabled: true,
  plugin: {
    inject: ['harnessChanges', 'harnessSettingsStore', 'harnessRoutes', 'harnessMutations'],
    provide: [],
    apply: setup,
  },
  browserStyles: ['/packages/settings/src/browser/style.css'],
  browser: '/packages/settings/src/browser/setup.js',
};
