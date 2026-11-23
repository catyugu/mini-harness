import type { BuiltinPlugin } from '../contracts/plugins.js';
import { setup } from './view-host.js';

export const manifest: BuiltinPlugin = {
  id: 'core:conversation', title: 'Conversation', description: 'Conversation interface', required: true,
  inject: ['harnessRegistry', 'harnessPi', 'harnessRuns', 'harnessWorkspaces', 'harnessRoutes', 'harnessApprovals'], provides: ['harnessConversationView'], setup,
  browser: '/packages/sessions/browser/conversation/plugin.js', browserRequires: ['core:workspace'],
};
