import type { PluginDescriptor } from '@mini-harness/contracts/plugins';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:workspaces-data', title: 'Workspace data',
  description: 'Live workspaces projection', required: true,
  browserInject: ['miniProjections'], browserProvides: ['miniWorkspaces'],
  browser: '/packages/workspaces/browser/data.js'
};
