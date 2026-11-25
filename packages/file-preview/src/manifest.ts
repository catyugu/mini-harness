import type { Plugin } from 'mini-harness/cordis';
import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const metadata: PluginInfo = {
  title: 'File preview',
  description: 'Preview and download workspace files and attachments.',
  icon: 'file-image',
  browser: 'packages/file-preview/src/browser/setup.js',
  browserStyles: ['packages/file-preview/src/browser/style.css'],
};

const plugin: Plugin.Object = {
  inject: ['harnessRoutes', 'harnessWorkspaces', 'harnessProfileScopes', 'harnessFileAccess'],
  apply: setup,
};

export default plugin;
