import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import { Type } from 'typebox';
import { defaultMessageMode, messageModes } from '@mini-harness/sessions/queue';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.ts';

const schema = defineConfig(
  Type.Object(
    {
      messageMode: Type.Union(
        messageModes.map((mode) => Type.Literal(mode)),
        { default: defaultMessageMode },
      ),
    },
    { additionalProperties: false },
  ),
);

const Config: typeof schema = {
  ...schema,
  '~standard': {
    ...schema['~standard'],
    validate(value) {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'queueMode')) {
        const { queueMode, ...current } = value as Record<string, unknown>;
        const previous = queueMode === 'followUp' ? 'queue' : queueMode === 'steer' ? 'steer' : undefined;
        if (previous && current.messageMode === undefined) current.messageMode = previous;
        return schema['~standard'].validate(current);
      }
      return schema['~standard'].validate(value);
    },
  },
};

export const metadata: PluginInfo = {
  title: 'Conversation',
  description: 'Conversation interface',

  browserStyles: ['packages/conversation/src/browser/conversation/style.css'],
  browser: 'packages/conversation/src/browser/conversation/setup.js',
};

const plugin: Plugin.Object = {
  Config,
  inject: [
    'harnessChanges',
    'harnessSessions',
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
  browser: 'packages/conversation/src/browser/conversation/composer-setup.js',
};

export const historyMetadata: PluginInfo = {
  title: 'History',
  description: 'Conversation messages and record contributions',
  browser: 'packages/conversation/src/browser/conversation/history-setup.js',
};

export const backgroundMetadata: PluginInfo = {
  title: 'Background tasks panel',
  description: 'Inspect independent work for this conversation',
  browser: 'packages/conversation/src/browser/conversation/background.js',
  browserStyles: ['packages/conversation/src/browser/conversation/background.css'],
};
