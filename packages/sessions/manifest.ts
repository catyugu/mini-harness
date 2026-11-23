import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:navigation', title: 'Sessions', description: 'Session identity and navigation', required: true,
  inject: ['harnessState', 'harnessWorkspaces'], provides: ['harnessRegistry', 'harnessSessions', 'harnessWorkspace'], setup,
  browser: '/packages/sessions/browser/navigation-plugin.js', browserRequires: ['core:workspace'],
};
