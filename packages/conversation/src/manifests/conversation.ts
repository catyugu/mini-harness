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

// Queue mode is an explicitly public UI preference, not an implicit server-config export.
export const browserConfig = (config: Readonly<Record<string, unknown>>) => ({ queueMode: config.queueMode });

export const metadata: PluginInfo = {
  title: 'Conversation',
  description: 'Conversation interface',

  browserStyles: ['/packages/conversation/src/browser/conversation/style.css'],
  browser: '/packages/conversation/src/browser/conversation/setup.js',
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
  title: 'Composer',
  description: 'Conversation input and draft contributions',
  browser: '/packages/conversation/src/browser/conversation/composer-setup.js',
};

export const historyMetadata: PluginInfo = {
  title: 'History',
  description: 'Conversation messages and record contributions',
  browser: '/packages/conversation/src/browser/conversation/history-setup.js',
};
