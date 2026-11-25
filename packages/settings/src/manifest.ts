import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Settings',
  description: 'Application settings',
  browserStyles: ['./browser/style.css'],
  browser: './browser/setup.ts',
};

const plugin: Plugin.Object = {
  inject: ['harnessChanges', 'harnessSettingsStore', 'harnessRoutes', 'harnessMutations'],
  provide: [],
  apply: setup,
};

export default plugin;
