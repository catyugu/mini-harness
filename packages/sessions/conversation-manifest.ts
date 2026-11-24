import { Type } from 'typebox';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './view-host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniComposer', 'miniMessages'],
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniModels', 'miniLayout', 'miniPages', 'miniHeader', 'miniProjections'],
  id: 'core:conversation', title: 'Conversation', description: 'Conversation interface', required: true,
  configChanges: 'live',
  configSchema: Type.Object({
    queueMode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')], { default: 'steer' }),
  }, { additionalProperties: false }),
  inject: ['harnessRegistry', 'harnessAgent', 'harnessRuns', 'harnessWorkspaces', 'harnessRoutes', 'harnessApprovals'], provides: ['harnessConversationView'], setup,
  browser: '/packages/sessions/browser/conversation/plugin.js', browserRequires: ['core:workspace'],
};
