import type { BuiltinPlugin } from '../contracts/plugins.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/packages/skills/client.js', inject: ['harnessState', 'harnessRoutes', 'harnessWorkspaces', 'harnessRegistry'],
};
