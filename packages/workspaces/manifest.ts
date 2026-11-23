import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:workspace', title: 'Workspaces', description: 'Workspace identity and registry', required: true,
  inject: ['harnessState', 'harnessRoutes'], provides: ['harnessWorkspaces'], setup,
  browser: '/packages/workspaces/browser.js', browserRequires: ['core:layout'],
};
