import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Layout',
  description: 'Application layout',
  browserStyles: [
    'packages/ui-layout/src/browser/frame.css',
    'packages/ui-layout/src/browser/responsive.css',
    'packages/ui-layout/src/browser/panels.css',
  ],
  browser: 'packages/ui-layout/src/browser/setup.js',
};
