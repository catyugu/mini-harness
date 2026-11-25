import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:sessions-data',
  title: 'Session data',
  description: 'Live conversation selection and navigation',
  defaultEnabled: true,
  browserProvides: ['miniSessions', 'miniSelection', 'harnessBrowser'],
  browser: '/packages/conversation/src/browser/session-data/setup.js',
};
