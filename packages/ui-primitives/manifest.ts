import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniPrimitives'],
  id: 'core:primitives', title: 'Controls', description: 'Shared interface controls', required: true,
  browser: '/packages/ui-primitives/browser.js',
};
