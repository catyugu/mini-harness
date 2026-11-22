import type { BuiltinPlugin } from '../../src/kernel/plugin-api.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/builtins/files.js', inject: ['harnessState', 'harnessWorkspace', 'harnessTools', 'harnessRoutes'],
};
