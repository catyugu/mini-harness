import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application', browserInject: ['harnessBrowser', 'miniProjections', 'miniTabs', 'miniComposer', 'miniMessages'],
  setup, defaultEnabled: true,
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  browserStyles: ['/packages/files/src/browser/style.css'],
  icon: 'files', browser: '/packages/files/src/browser/setup.js', inject: ['harnessFileAccess', 'harnessWorkspaces', 'harnessSessions', 'harnessTools', 'harnessRoutes', 'harnessChanges'],
};
