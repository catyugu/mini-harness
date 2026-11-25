import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.ts';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Browser transport',
  description: 'Browser startup and projections',
};

const plugin: Plugin.Object = {
  inject: ['harnessPluginCatalog', 'harnessRoutes', 'harnessChanges'],
  provide: ['harnessGateway'],
  apply: setup,
};

export default plugin;
