import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Workspace navigation',
  description: 'Workspace picker and browser panels',
  browserStyles: ['../browser/workspace/style.css'],
  browser: '../browser/workspace/setup.ts',
};
