import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.ts';

export const metadata: PluginInfo = {
  title: 'Workspaces',
  description: 'Workspace identity and registry',
};

const plugin: Plugin.Object = {
  inject: ['harnessChanges', 'harnessState', 'harnessScopes', 'harnessSettingsStore'],
  provide: ['harnessWorkspaces'],
  apply: setup,
};

export default plugin;
