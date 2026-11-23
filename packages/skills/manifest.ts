import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application', browserInject: ['harnessBrowser'],
  setup, defaultEnabled: true, browserRequires: ['core:conversation'],
  provides: ['harnessSkills'],
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/packages/skills/client.js', inject: ['harnessState', 'harnessRoutes', 'harnessWorkspaces', 'harnessRegistry'],
};
