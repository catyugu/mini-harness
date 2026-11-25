import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Session data',
  description: 'Live conversation selection and navigation',
  browser: '/packages/conversation/src/browser/session-data/setup.js',
};
