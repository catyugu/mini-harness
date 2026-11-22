import type { BuiltinPlugin } from '../../src/contracts/plugins.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/features/skills/client.js', inject: ['harnessState', 'harnessRoutes', 'harnessWorkspaces', 'harnessRegistry'],
};
