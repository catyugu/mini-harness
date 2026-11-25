import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.js';

export const manifest: PluginDescriptor = {
  scope: 'application',
  id: 'core:runs',
  title: 'Runs',
  description: 'Run lifecycle',
  defaultEnabled: true,
  plugin: {
    inject: [
      'harnessScopes',
      'harnessRegistry',
      'harnessMutations',
      'harnessAgent',
      'harnessModelPreference',
    ],
    provide: ['harnessRuns', 'harnessExecution'],
    apply: setup,
  },
};
