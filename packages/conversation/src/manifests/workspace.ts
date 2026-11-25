import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  title: 'Workspace navigation',
  description: 'Workspace picker and browser panels',
  browserStyles: ['packages/conversation/src/browser/workspace/style.css'],
  browser: 'packages/conversation/src/browser/workspace/setup.js',
};
