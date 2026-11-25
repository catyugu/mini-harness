import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  title: 'Plugins',
  description: 'Plugin management',
  browserStyles: ['packages/plugins/src/browser/style.css'],
  browser: 'packages/plugins/src/browser/setup.js',
};

const plugin: Plugin.Object = {
  inject: ['harnessPluginCatalog', 'harnessRoutes', 'harnessChanges'],
  provide: [],
  apply: setup,
};

export default plugin;
