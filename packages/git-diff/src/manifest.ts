import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.js';

export const manifest: PluginDescriptor = {
  id: 'git-diff',
  title: 'Git changes',
  description: 'Inspect staged, unstaged, and untracked files.',
  icon: 'list-checks',
  scope: 'application',
  defaultEnabled: true,
  plugin: { inject: ['harnessRoutes', 'harnessWorkspaces', 'harnessScopes', 'harnessFileAccess'], apply: setup },
  browser: '/packages/git-diff/src/browser/setup.js',
  browserStyles: ['/packages/git-diff/src/browser/style.css'],
};
