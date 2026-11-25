import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Approval data',
  description: 'Browser projection for conversation approvals',
  browser: './setup.ts',
};
