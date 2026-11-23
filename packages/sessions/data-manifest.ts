import type { PluginDescriptor } from '#mini-harness/contracts/plugins.js';

export const manifest: PluginDescriptor = {
  scope: 'application', id: 'core:sessions-data', title: 'Session data',
  description: 'Live conversation selection and navigation', required: true,
  browserInject: ['miniProjections', 'miniWorkspaces'],
  browserProvides: ['miniSessions', 'miniSelection', 'harnessBrowser'],
  browser: '/packages/sessions/browser/data.js'
};
