import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:sessions',
  title: 'Sessions',
  description: 'Session identity and durable history',
  defaultEnabled: true,
  plugin: {
    inject: ['harnessScopes', 'harnessSettingsStore', 'harnessState', 'harnessWorkspaces'],
    provide: ['harnessRegistry', 'harnessSessions'],
    apply: setup,
  },
};
