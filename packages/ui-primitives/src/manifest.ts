import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniAppearance'],
  browserProvides: ['miniPrimitives'],
  id: 'core:primitives', title: 'Controls', description: 'Shared interface controls', required: true,
  browserStyles: ['/packages/ui-primitives/src/browser/style.css'],
  browser: '/packages/ui-primitives/src/browser/setup.js',
};
