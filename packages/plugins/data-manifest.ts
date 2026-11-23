import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:plugins-data', title: 'Plugin data',
  description: 'Live plugins projection', required: true,
  browserInject: ['miniProjections'], browserProvides: ['miniPluginData'],
  browser: '/packages/plugins/browser/data.js'
};
