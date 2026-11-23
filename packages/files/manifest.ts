import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: BuiltinPlugin = {
  setup, defaultEnabled: true, browserRequires: ['core:layout'],
  provides: ['harnessFiles'],
  id: 'files', title: 'Workspace files', description: 'Read, search and edit files within the workspace.',
  icon: 'files', browser: '/packages/files/client.js', inject: ['harnessState', 'harnessWorkspace', 'harnessWorkspaces', 'harnessRegistry', 'harnessTools', 'harnessRoutes'],
};
