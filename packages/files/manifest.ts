import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './host.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application', browserInject: ['harnessBrowser', 'miniProjections', 'miniTabs', 'miniComposer'],
  setup, defaultEnabled: true,
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/packages/files/client.js', inject: ['harnessFileAccess', 'harnessWorkspaces', 'harnessRegistry', 'harnessTools', 'harnessRoutes', 'harnessScopes', 'harnessChanges'],
};
