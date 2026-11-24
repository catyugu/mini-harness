import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setupAdministration } from '../server/administration.js';
import type {} from '../server/api.js';

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
  inject: ['harnessModels'], provides: ['harnessModelPreference'],
  setup(ctx, api) {
    ctx.provide('harnessModelPreference', {
      recent: () => api.configuration.get<ModelChoice>('model'),
      async remember(model: ModelChoice) {
        if ((!model.provider && !model.id) || ctx.harnessModels.resolve(model)) await api.configuration.set('model', model);
      }
    });
  }
};

export const administrationManifest: PluginDescriptor = {
  scope: 'application', id: 'core:model-admin', title: 'Models', description: 'Model endpoints and credentials',
  inject: ['harnessModels', 'harnessModelStore', 'harnessModelPreference', 'harnessSettingsStore', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  setup: setupAdministration,
  browserInject: ['miniSettings', 'miniProjections', 'miniSettingsRegistry'], browserProvides: ['miniModels'],
  browserStyles: ['/packages/models/src/browser/style.css'],
  browser: '/packages/models/src/browser/setup.js',
};
