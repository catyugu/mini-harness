import { Type } from 'typebox';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniConversation'],
  browserInject: ['miniSelection', 'miniApprovals', 'harnessBrowser', 'miniSessions', 'miniWorkspaces', 'miniLayout', 'miniPages', 'miniHeader', 'miniProjections', 'miniSlots', 'miniSettingsRegistry'],
  id: 'core:conversation', title: 'Conversation', description: 'Conversation interface', required: true,
  configChanges: 'live',
  configSchema: Type.Object({
    queueMode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')], { default: 'steer' }),
  }, { additionalProperties: false }),
  inject: ['harnessChanges', 'harnessRegistry', 'harnessModelPreference', 'harnessRuns', 'harnessWorkspaces', 'harnessRoutes', 'harnessApprovals'], setup,
  browserStyles: ['/packages/conversation/src/browser/conversation/style.css'],
  browser: '/packages/conversation/src/browser/conversation/setup.js',
};

export const composerManifest: PluginDescriptor = {
  scope: 'application', id: 'core:composer', title: 'Composer', description: 'Conversation input and draft contributions', required: true,
  browserProvides: ['miniComposer'], browserInject: ['miniConversation', 'miniSelection', 'miniModels', 'miniSlots'],
  browser: '/packages/conversation/src/browser/conversation/composer-setup.js',
};

export const historyManifest: PluginDescriptor = {
  scope: 'application', id: 'core:history', title: 'History', description: 'Conversation messages and record contributions', required: true,
  browserProvides: ['miniMessages'], browserInject: ['miniConversation', 'miniSlots', 'miniDialogs'],
  browser: '/packages/conversation/src/browser/conversation/history-setup.js',
};
