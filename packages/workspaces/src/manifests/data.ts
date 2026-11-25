import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Workspace data',
  description: 'Live workspaces projection',
  browser: '/packages/workspaces/src/browser/setup.js',
};
