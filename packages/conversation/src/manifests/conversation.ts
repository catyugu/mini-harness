import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import { Type } from 'typebox';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.ts';

const Config = defineConfig(
  Type.Object(
    {
      queueMode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')], { default: 'steer' }),
    },
    { additionalProperties: false },
  ),
);

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Conversation',
  description: 'Conversation interface',

  browserStyles: ['../browser/conversation/style.css'],
  browser: '../browser/conversation/setup.ts',
};

const plugin: Plugin.Object = {
  Config,
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
  browser: '../browser/conversation/composer-setup.ts',
};

export const historyMetadata: PluginInfo = {
  scope: 'application',
  title: 'History',
  description: 'Conversation messages and record contributions',
  browser: '../browser/conversation/history-setup.ts',
};
