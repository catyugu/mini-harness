import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:navigation', title: 'Navigation',
  description: 'Session navigation and search', defaultEnabled: true,
  browserStyles: ['/packages/conversation/src/browser/navigation/style.css'],
  browser: '/packages/conversation/src/browser/navigation/setup.js'
};
