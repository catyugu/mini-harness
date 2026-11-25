import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Plugins',
  description: 'Plugin management',
  browserStyles: ['./browser/style.css'],
  browser: './browser/setup.ts',
};

const plugin: Plugin.Object = {
  inject: ['harnessPluginCatalog', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  provide: [],
  apply: setup,
};

export default plugin;
