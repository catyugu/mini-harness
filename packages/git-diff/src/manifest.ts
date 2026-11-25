import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  title: 'Git changes',
  description: 'Inspect staged, unstaged, and untracked files.',
  icon: 'list-checks',
  scope: 'application',
  browser: './browser/setup.ts',
  browserStyles: ['./browser/style.css'],
};

const plugin: Plugin.Object = {
  inject: ['harnessRoutes', 'harnessWorkspaces', 'harnessScopes', 'harnessFileAccess'],
  apply: setup,
};

export default plugin;
