import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:approval-data', title: 'Approval data',
  description: 'Browser projection for conversation approvals', defaultEnabled: true,
  inject: ['harnessApprovals'],
  browser: '/packages/approvals/src/browser/setup.js', browserInject: ['miniProjections'], browserProvides: ['miniApprovals']
};
