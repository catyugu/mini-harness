import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniLayout', 'miniPages', 'miniHeader', 'miniWorkspace'],
  id: 'core:navigation', title: 'Sessions', description: 'Session identity and navigation', required: true,
  inject: ['harnessScopes', 'harnessSettingsStore', 'harnessState', 'harnessWorkspaces'], provides: ['harnessRegistry', 'harnessSessions', 'harnessWorkspace'], setup,
  browser: '/packages/sessions/browser/navigation-plugin.js', browserRequires: ['core:workspace'],
};
