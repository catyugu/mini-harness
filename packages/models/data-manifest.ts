import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:models-data', title: 'Model data',
  description: 'Live model and credential availability', required: true,
  browserInject: ['miniProjections'], browserProvides: ['miniModels'],
  browser: '/packages/models/browser/data.js'
};
