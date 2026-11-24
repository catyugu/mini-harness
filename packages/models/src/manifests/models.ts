import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setupAdministration } from '../server/administration.js';
import type {} from '../server/api.js';
import type {} from '@mini-harness/kernel/observations';
import type {} from '@mini-harness/kernel/mutation-api';
import type {} from '@mini-harness/transport/projection-api';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:models', title: 'Recent model', description: 'Accepted user model selection', defaultEnabled: true,
  configChanges: 'live',
  configSchema: Type.Object({
    model: Type.Object({
      provider: Type.String({ maxLength: 160, default: '' }),
      id: Type.String({ maxLength: 160, default: '' }),
    }, { default: {}, additionalProperties: false }),
  }, { additionalProperties: false }),
  validateConfig(config, { service, operation }) {
    const model = config.model as ModelChoice;
    if (operation !== 'mount' && (model.provider || model.id) && !service('harnessModels').resolve(model))
      throw new DomainError('invalid_input', 'Unknown model: ' + model.provider + '/' + model.id);
  },
  inject: ['harnessModels', 'harnessChanges'], provides: ['harnessModelPreference'],
  setup(ctx, api) {
    let pending = Promise.resolve();
    let current = api.configuration.get<ModelChoice>('model');
    let saving: ModelChoice | undefined;
    const same = (left: ModelChoice, right?: ModelChoice) => left.provider === right?.provider && left.id === right.id;
    const select = (model: ModelChoice) => {
      if (same(model, current)) return;
      current = { ...model };
      ctx.harnessChanges.invalidate('models');
    };
    api.configuration.subscribe<ModelChoice>('model', (model) => {
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
        try { await api.configuration.set('model', choice); }
        finally { saving = undefined; }
      });
      pending = write.catch((error) => { ctx.logger.warn('Could not save recent model: %s', String(error)); });
      return write;
    };
    ctx.provide('harnessModelPreference', { recent: () => ({ ...current }), remember });
    ctx.on('harness/observe', (event) => {
      if (event.type === 'input-accepted' && event.source === 'user' && event.runSource === 'user' && !event.parentId) {
        void remember(event.model).catch(() => { /* The preference owner reports failed writes. */ });
      }
    });
    ctx.on('harness/quiesce', () => pending);
  }
};

export const administrationManifest: PluginDescriptor = {
  scope: 'application', id: 'core:model-admin', title: 'Models', description: 'Model endpoints and credentials',
  inject: ['harnessModels', 'harnessModelStore', 'harnessModelPreference', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  setup: setupAdministration,
  browserInject: ['miniSettings', 'miniProjections', 'miniSettingsRegistry'], browserProvides: ['miniModels'],
  browserStyles: ['/packages/models/src/browser/style.css'],
  browser: '/packages/models/src/browser/setup.js',
};
