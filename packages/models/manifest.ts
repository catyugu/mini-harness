import { Type } from 'typebox';
import { HttpError } from '@mini-harness/contracts/routes';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSettings', 'miniProjections'], browserProvides: ['miniModels'],
  id: 'core:models', title: 'Models', description: 'Model endpoints and credentials', required: true,
  configChanges: 'live',
  migrateConfig: { model: 'model' },
  configSchema: Type.Object({
    model: Type.Object({
      provider: Type.String({ maxLength: 160, default: '' }),
      id: Type.String({ maxLength: 160, default: '' }),
    }, { default: {}, additionalProperties: false }),
  }, { additionalProperties: false }),
  validateConfig(config, models, operation) {
    const model = config.model as ModelChoice;
    if (operation === 'write' && (model.provider || model.id) && !models.resolve(model))
      throw new HttpError('invalid_input', 'Unknown model: ' + model.provider + '/' + model.id);
  },
  inject: ['harnessModels', 'harnessModelAdmin', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  provides: ['harnessModelPreference'], setup,
  browser: '/packages/models/browser.js', browserRequires: ['core:settings'],
};
