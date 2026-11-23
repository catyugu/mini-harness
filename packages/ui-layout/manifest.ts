import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSlots'],
  browserProvides: ['miniLayout', 'miniPages', 'miniHeader', 'miniTabs'],
  id: 'core:layout', title: 'Layout', description: 'Application layout', required: true,
  browser: '/packages/ui-layout/browser.js', browserRequires: ['core:primitives'],
};
