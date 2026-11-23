import type { PluginDescriptor } from '@mini-harness/contracts/plugins';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniPrimitives'],
  id: 'core:primitives', title: 'Controls', description: 'Shared interface controls', required: true,
  browser: '/packages/ui-primitives/browser.js', browserRequires: ['core:theme'],
};
