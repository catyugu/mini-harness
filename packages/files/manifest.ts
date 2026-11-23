import type { BuiltinPlugin } from '../contracts/plugins.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/packages/files/client.js', inject: ['harnessState', 'harnessWorkspace', 'harnessWorkspaces', 'harnessRegistry', 'harnessTools', 'harnessRoutes'],
};
