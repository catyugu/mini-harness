import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Approval data',
  description: 'Browser projection for conversation approvals',
  browser: 'packages/approvals/src/browser/setup.js',
};
