import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'UI slots',
  description: 'Own and dispose browser contributions',
  browser: './browser/setup.ts',
};
