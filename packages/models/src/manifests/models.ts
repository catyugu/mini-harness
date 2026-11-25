import { defineConfig } from '@mini-harness/plugin-api/configuration';
import type { Plugin } from 'mini-harness/cordis';
import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setupAdministration } from '../server/administration.ts';

const Config = defineConfig(
  Type.Object(
    {
      model: Type.Object(
        {
          provider: Type.String({ maxLength: 160, default: '' }),
          id: Type.String({ maxLength: 160, default: '' }),
        },
        { default: {}, additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
);

export const metadata: PluginInfo = {
  title: 'Recent model',
  description: 'Accepted user model selection',
};

const plugin: Plugin.Object = {
  Config,
  inject: ['harnessModels', 'harnessChanges', 'harnessPluginSettings'],
  provide: ['harnessModelPreference'],
  apply(ctx) {
    ctx.on('internal/update', (next) => {
      const model = (next as { model: ModelChoice }).model;
      if ((model.provider || model.id) && !ctx.harnessModels.resolve(model))
        throw new DomainError('invalid_input', 'Unknown model: ' + model.provider + '/' + model.id);
    });
    let pending = Promise.resolve();
    let current = ctx.harnessPluginSettings.get<ModelChoice>('model');
    let saving: ModelChoice | undefined;
    const same = (left: ModelChoice, right?: ModelChoice) =>
      left.provider === right?.provider && left.id === right.id;
    const select = (model: ModelChoice) => {
      if (same(model, current)) return;
      current = { ...model };
      ctx.harnessChanges.invalidate('models');
    };
    ctx.harnessPluginSettings.subscribe<ModelChoice>('model', (model) => {
      // A completed older write must not overwrite a newer accepted selection.
      if (!same(model, saving)) select(model);
    });
    const remember = (model: ModelChoice) => {
      if ((model.provider || model.id) && !ctx.harnessModels.resolve(model)) return Promise.resolve();
      select(model);
      const choice = current;
      const write = pending.then(async () => {
        if (choice !== current) return;
        saving = choice;
        try {
          await ctx.harnessPluginSettings.set('model', choice);
        } finally {
          saving = undefined;
        }
      });
      pending = write.catch((error) => {
        ctx.logger.warn('Could not save recent model: %s', String(error));
      });
      return write;
    };
    ctx.provide('harnessModelPreference', { recent: () => ({ ...current }), remember });
    ctx.on('harness/observe', (event) => {
      if (
        event.type === 'input-accepted' &&
        event.source === 'user' &&
        event.runSource === 'user' &&
        !event.parentId
      ) {
        void remember(event.model).catch(() => {
          /* The preference owner reports failed writes. */
        });
      }
    });
    ctx.on('harness/quiesce', () => pending);
  },
};

export default plugin;

export const administrationMetadata: PluginInfo = {
  title: 'Models',
  description: 'Model endpoints and credentials',
  browserStyles: ['packages/models/src/browser/style.css'],
  browser: 'packages/models/src/browser/setup.js',
};

export const administration: Plugin.Object = {
  inject: [
    'harnessModels',
    'harnessModelStore',
    'harnessModelPreference',
    'harnessState',
    'harnessRoutes',
    'harnessChanges',
  ],
  apply: setupAdministration,
};
