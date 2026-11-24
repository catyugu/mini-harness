import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniLayout', 'miniPages', 'miniHeader', 'miniWorkspace', 'miniSlots'],
  id: 'core:navigation', title: 'Sessions', description: 'Session identity and navigation', required: true,
  inject: ['harnessScopes', 'harnessSettingsStore', 'harnessState', 'harnessWorkspaces'], provides: ['harnessRegistry', 'harnessSessions'], setup,
  browser: '/packages/sessions/browser/navigation-plugin.js',
};
