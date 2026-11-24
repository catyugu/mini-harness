import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:workspaces-data', title: 'Workspace data',
  description: 'Live workspaces projection', defaultEnabled: true,
  browserInject: ['miniProjections'], browserProvides: ['miniWorkspaces'],
  browser: '/packages/workspaces/src/browser/setup.js'
};
