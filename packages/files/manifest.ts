import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application', browserInject: ['harnessBrowser'],
  setup, defaultEnabled: true, browserRequires: ['core:layout', 'core:conversation'],
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/packages/files/client.js', inject: ['harnessFileAccess', 'harnessWorkspaces', 'harnessRegistry', 'harnessTools', 'harnessRoutes', 'harnessScopes'],
};
