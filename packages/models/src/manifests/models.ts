import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import type {} from '../server/api.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:models', title: 'Recent model preference', description: 'Application default model selection', required: true,
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
  inject: ['harnessModels'],
  provides: ['harnessModelPreference'],
  setup(ctx, api) {
    api.provide('harnessModelPreference', {
      recent: () => api.configuration.get<ModelChoice>('model'),
      async remember(model) {
        if ((!model.provider && !model.id) || ctx.harnessModels.resolve(model))
          await api.configuration.set('model', model);
      },
      subscribe: (listener) => api.configuration.subscribe('model', listener)
    });
  }
};
