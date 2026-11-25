import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:plugins',
  title: 'Plugins',
  description: 'Plugin management',
  defaultEnabled: true,
  plugin: {
    inject: [
      'harnessPluginCatalog',
      'harnessSettingsStore',
      'harnessState',
      'harnessRoutes',
      'harnessMutations',
      'harnessChanges',
    ],
    provide: [],
    apply: setup,
  },
  browserStyles: ['/packages/plugins/src/browser/style.css'],
  browser: '/packages/plugins/src/browser/setup.js',
};
