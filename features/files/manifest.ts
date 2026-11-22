import type { BuiltinPlugin } from '../../src/contracts/plugins.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/features/files/client.js', inject: ['harnessState', 'harnessWorkspace', 'harnessTools', 'harnessRoutes'],
};
