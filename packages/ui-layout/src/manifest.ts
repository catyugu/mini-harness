import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserInject: ['miniSlots', 'miniPrimitives'],
  browserProvides: ['miniLayout', 'miniPages', 'miniHeader', 'miniTabs', 'miniDialogs'],
  id: 'core:layout', title: 'Layout', description: 'Application layout', required: true,
  browserStyles: ['/packages/ui-layout/src/browser/frame.css', '/packages/ui-layout/src/browser/responsive.css', '/packages/ui-layout/src/browser/panels.css'],
  browser: '/packages/ui-layout/src/browser/setup.js',
};
