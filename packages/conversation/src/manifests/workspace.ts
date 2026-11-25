import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:workspace-navigation',
  title: 'Workspace navigation',
  description: 'Workspace picker and browser panels',
  defaultEnabled: true,
  browserStyles: ['/packages/conversation/src/browser/workspace/style.css'],
  browser: '/packages/conversation/src/browser/workspace/setup.js',
};
