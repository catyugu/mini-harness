import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application', browserInject: ['harnessBrowser', 'miniProjections', 'miniComposer', 'miniSlots'],
  setup, defaultEnabled: true,
  id: 'skills', title: 'Skills', description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills', browser: '/packages/skills/src/browser/setup.js', inject: ['harnessState', 'harnessScopes', 'harnessRoutes', 'harnessWorkspaces', 'harnessRegistry', 'harnessTools'],
};
