import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './view-host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniComposer', 'miniMessages'],
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniSettingsData', 'miniModels', 'miniLayout', 'miniPages', 'miniHeader'],
  id: 'core:conversation', title: 'Conversation', description: 'Conversation interface', required: true,
  inject: ['harnessRegistry', 'harnessAgent', 'harnessRuns', 'harnessWorkspaces', 'harnessRoutes', 'harnessApprovals'], provides: ['harnessConversationView'], setup,
  browser: '/packages/sessions/browser/conversation/plugin.js', browserRequires: ['core:workspace'],
};
