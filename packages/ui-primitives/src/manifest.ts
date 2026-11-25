import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Controls',
  description: 'Shared interface controls',
  browserStyles: ['/packages/ui-primitives/src/browser/style.css'],
  browser: '/packages/ui-primitives/src/browser/setup.js',
};
