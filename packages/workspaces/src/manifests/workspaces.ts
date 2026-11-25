import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from '../server/setup.ts';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:workspace',
  title: 'Workspaces',
  description: 'Workspace identity and registry',
  defaultEnabled: true,
  plugin: {
    inject: ['harnessChanges', 'harnessState', 'harnessScopes', 'harnessSettingsStore'],
    provide: ['harnessWorkspaces'],
    apply: setup,
  },
};
