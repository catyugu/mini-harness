import type { PluginDescriptor } from '../contracts/plugins.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:approvals-data', title: 'Approval data',
  description: 'Live approvals projection', required: true,
  browserInject: ['miniProjections'], browserProvides: ['miniApprovals'],
  browser: '/packages/approvals/browser/data.js'
};
