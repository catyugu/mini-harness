import type { PluginDescriptor } from '@mini-harness/contracts/plugins';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:approvals-data', title: 'Approval data',
  description: 'Live approvals projection', required: true,
  browserInject: ['miniProjections'], browserProvides: ['miniApprovals'],
  browser: '/packages/approvals/browser/data.js'
};
