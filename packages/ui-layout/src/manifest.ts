import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  browserProvides: ['miniLayout', 'miniPages', 'miniHeader', 'miniTabs', 'miniDialogs'],
  id: 'core:layout',
  title: 'Layout',
  description: 'Application layout',
  defaultEnabled: true,
  browserStyles: [
    '/packages/ui-layout/src/browser/frame.css',
    '/packages/ui-layout/src/browser/responsive.css',
    '/packages/ui-layout/src/browser/panels.css',
  ],
  browser: '/packages/ui-layout/src/browser/setup.js',
};
