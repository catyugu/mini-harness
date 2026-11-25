import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './setup.ts';

export const metadata: PluginInfo = {
  title: 'Runs',
  description: 'Run lifecycle',
};

const plugin: Plugin.Object = {
  inject: ['harnessScopes', 'harnessRegistry', 'harnessMutations', 'harnessAgent', 'harnessModelPreference'],
  provide: ['harnessRuns', 'harnessExecution'],
  apply: setup,
};

export default plugin;
