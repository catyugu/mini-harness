import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:sessions', title: 'Sessions', description: 'Session identity and durable history', required: true,
  inject: ['harnessScopes', 'harnessRoutes', 'harnessSettingsStore', 'harnessState', 'harnessWorkspaces'], provides: ['harnessRegistry', 'harnessSessions'], setup,
};
