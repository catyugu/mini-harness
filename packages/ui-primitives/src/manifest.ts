import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Controls',
  description: 'Shared interface controls',
  browserStyles: ['./browser/style.css'],
  browser: './browser/setup.ts',
};
