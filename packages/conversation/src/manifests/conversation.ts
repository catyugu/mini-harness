import { Type } from 'typebox';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniComposer', 'miniMessages'],
  browserInject: ['miniApprovals', 'harnessBrowser', 'miniSelection', 'miniSessions', 'miniWorkspaces', 'miniModels', 'miniLayout', 'miniPages', 'miniHeader', 'miniProjections', 'miniSlots', 'miniDialogs', 'miniSettingsRegistry'],
  id: 'core:conversation', title: 'Conversation', description: 'Conversation interface', required: true,
  configChanges: 'live',
  configSchema: Type.Object({
    queueMode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')], { default: 'steer' }),
  }, { additionalProperties: false }),
  inject: ['harnessChanges', 'harnessRegistry', 'harnessModelPreference', 'harnessRuns', 'harnessWorkspaces', 'harnessRoutes', 'harnessApprovals'], setup,
  browserStyles: ['/packages/conversation/src/browser/conversation/style.css', '/packages/conversation/src/browser/conversation/approvals.css'],
  browser: '/packages/conversation/src/browser/conversation/setup.js',
};
