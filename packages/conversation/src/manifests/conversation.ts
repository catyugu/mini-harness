import type { Plugin } from 'mini-harness/cordis';
import { Type } from 'typebox';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.ts';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Conversation',
  description: 'Conversation interface',
  configChanges: 'live',
  browserConfig: ['queueMode'],
  configSchema: Type.Object(
    {
      queueMode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')], { default: 'steer' }),
    },
    { additionalProperties: false },
  ),
  browserStyles: ['/packages/conversation/src/browser/conversation/style.css'],
  browser: '/packages/conversation/src/browser/conversation/setup.js',
};

const plugin: Plugin.Object = {
  inject: [
    'harnessChanges',
    'harnessRegistry',
    'harnessRuns',
    'harnessWorkspaces',
    'harnessRoutes',
    'harnessApprovals',
  ],
  apply: setup,
};

export default plugin;

export const composerMetadata: PluginInfo = {
  scope: 'application',
  title: 'Composer',
  description: 'Conversation input and draft contributions',
  browser: '/packages/conversation/src/browser/conversation/composer-setup.js',
};

export const historyMetadata: PluginInfo = {
  scope: 'application',
  title: 'History',
  description: 'Conversation messages and record contributions',
  browser: '/packages/conversation/src/browser/conversation/history-setup.js',
};
