import { Type } from 'typebox';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.ts';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:conversation',
  title: 'Conversation',
  description: 'Conversation interface',
  defaultEnabled: true,
  configChanges: 'live',
  configSchema: Type.Object(
    {
      queueMode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')], { default: 'steer' }),
    },
    { additionalProperties: false },
  ),
  plugin: {
    inject: [
      'harnessChanges',
      'harnessRegistry',
      'harnessRuns',
      'harnessWorkspaces',
      'harnessRoutes',
      'harnessApprovals',
    ],
    apply: setup,
  },
  browserStyles: ['/packages/conversation/src/browser/conversation/style.css'],
  browser: '/packages/conversation/src/browser/conversation/setup.js',
};

export const composerManifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:composer',
  title: 'Composer',
  description: 'Conversation input and draft contributions',
  defaultEnabled: true,
  browser: '/packages/conversation/src/browser/conversation/composer-setup.js',
};

export const historyManifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:history',
  title: 'History',
  description: 'Conversation messages and record contributions',
  defaultEnabled: true,
  browser: '/packages/conversation/src/browser/conversation/history-setup.js',
};
