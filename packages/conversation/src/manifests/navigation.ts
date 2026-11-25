import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Navigation',
  description: 'Session navigation and search',
  browserStyles: ['/packages/conversation/src/browser/navigation/style.css'],
  browser: '/packages/conversation/src/browser/navigation/setup.js',
};
