import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  title: 'Background work',
  description: 'Run eligible tools independently and inspect their output.',
  browser: 'packages/background/src/browser/setup.js',
  browserStyles: ['packages/background/src/browser/style.css'],
};

const plugin: Plugin.Object = {
  inject: ['harnessTasks', 'harnessTools', 'harnessSessions', 'harnessRuns', 'harnessProfileScopes'],
  apply: setup,
};

export default plugin;
