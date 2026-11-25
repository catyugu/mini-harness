import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

/** One metadata definition for the host, settings, and browser loader. */
export const metadata: PluginInfo = {
  title: 'Workspace files',
  description: 'Read, search and edit files within the workspace.',
  browserStyles: ['packages/files/src/browser/style.css'],
  icon: 'files',
  browser: 'packages/files/src/browser/setup.js',
};

const plugin: Plugin.Object = {
  inject: [
    'harnessFileAccess',
    'harnessState',
    'harnessWorkspaces',
    'harnessSessions',
    'harnessTools',
    'harnessChanges',
    'harnessProfileScopes',
  ],
  apply: setup,
};

export default plugin;
