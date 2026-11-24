import type { PluginDescriptor } from '@mini-harness/contracts/plugins';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSlots', 'miniPrimitives'],
  browserProvides: ['miniLayout', 'miniPages', 'miniHeader', 'miniTabs', 'miniDialogs'],
  id: 'core:layout', title: 'Layout', description: 'Application layout', required: true,
  browser: '/packages/ui-layout/browser.js',
};
