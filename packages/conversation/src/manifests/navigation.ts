import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Navigation',
  description: 'Session navigation and search',
  browserStyles: ['../browser/navigation/style.css'],
  browser: '../browser/navigation/setup.ts',
};
