import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniWorkspace'],
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniTabs', 'miniDialogs', 'miniSlots'],
  id: 'core:workspace', title: 'Workspaces', description: 'Workspace identity and registry', required: true,
  inject: ['harnessChanges', 'harnessState', 'harnessRoutes'], provides: ['harnessWorkspaces'], setup,
  browser: '/packages/conversation/browser/workspaces.js',
};
