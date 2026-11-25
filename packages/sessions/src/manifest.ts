import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.ts';

export const metadata: PluginInfo = {
  title: 'Sessions',
  description: 'Session identity and durable history',
};

const plugin: Plugin.Object = {
  inject: ['harnessScopes', 'harnessSettingsStore', 'harnessState', 'harnessWorkspaces'],
  provide: ['harnessRegistry', 'harnessSessions'],
  apply: setup,
};

export default plugin;
