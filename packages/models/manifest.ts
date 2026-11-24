import { Type } from 'typebox';
import { HttpError } from '@mini-harness/contracts/routes';
import type { ModelChoice } from '@mini-harness/contracts/conversation';
import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

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
      throw new HttpError('invalid_input', 'Unknown model: ' + model.provider + '/' + model.id);
  },
  inject: ['harnessModels', 'harnessModelAdmin', 'harnessState', 'harnessRoutes', 'harnessMutations', 'harnessChanges'],
  provides: ['harnessModelPreference'], setup,
  browser: '/packages/models/browser.js',
};
