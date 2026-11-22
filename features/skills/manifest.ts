import type { BuiltinPlugin } from '../../src/kernel/plugin-api.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/builtins/skills.js', inject: ['harnessState', 'harnessRoutes'],
};
