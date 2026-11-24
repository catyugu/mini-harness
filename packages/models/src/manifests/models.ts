import { Type } from 'typebox';
import { DomainError } from '@mini-harness/platform/errors';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSettings', 'miniProjections', 'miniSettingsRegistry'], browserProvides: ['miniModels'],
  id: 'core:models', title: 'Models', description: 'Model endpoints and credentials', required: true,
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
  inject: ['harnessModels', 'harnessModelStore', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  provides: ['harnessModelPreference'], setup,
  browserStyles: ['/packages/models/src/browser/style.css'],
  browser: '/packages/models/src/browser/setup.js',
};
