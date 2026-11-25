import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  title: 'Settings',
  description: 'Application settings',
  browserStyles: ['packages/settings/src/browser/style.css'],
  browser: 'packages/settings/src/browser/setup.js',
};

const plugin: Plugin.Object = {
  inject: ['harnessChanges', 'harnessProfileConfig', 'harnessRoutes'],
  provide: [],
  apply: setup,
};

export default plugin;
