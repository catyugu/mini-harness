import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:navigation', title: 'Navigation',
  description: 'Session navigation and search', required: true,
  browserInject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniLayout', 'miniPages', 'miniHeader', 'miniWorkspace', 'miniSlots'],
  browserStyles: ['/packages/conversation/src/browser/navigation/style.css'],
  browser: '/packages/conversation/src/browser/navigation/setup.js'
};
