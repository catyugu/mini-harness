import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

/** One metadata definition for the host, settings, and browser loader. */
export const metadata: PluginInfo = {
  title: 'Skills',
  description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills',
  browser: '/packages/skills/src/browser/setup.js',
};

const plugin: Plugin.Object = {
  inject: [
    'harnessState',
    'harnessWorkspaces',
    'harnessSessions',
    'harnessTools',
    'harnessPrompt',
    'harnessScopes',
  ],
  apply: setup,
};

export default plugin;
