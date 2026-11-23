import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniWorkspace'],
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniTabs'],
  id: 'core:workspace', title: 'Workspaces', description: 'Workspace identity and registry', required: true,
  inject: ['harnessState', 'harnessRoutes'], provides: ['harnessWorkspaces'], setup,
  browser: '/packages/workspaces/browser.js', browserRequires: ['core:layout'],
};
