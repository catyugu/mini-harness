import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  protocol: 2, scope: 'application',
  browserProvides: ['miniPrimitives'],
  id: 'core:primitives', title: 'Controls', description: 'Shared interface controls', required: true,
  browser: '/packages/ui-primitives/browser.js', browserRequires: ['core:theme'],
};
