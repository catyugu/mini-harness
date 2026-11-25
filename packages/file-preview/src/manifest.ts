import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

export const manifest: PluginDescriptor = {
  id: 'file-preview',
  title: 'File preview',
  description: 'Preview and download workspace files and attachments.',
  icon: 'file-image',
  scope: 'application',
  defaultEnabled: true,
  plugin: {
    inject: ['harnessRoutes', 'harnessWorkspaces', 'harnessScopes', 'harnessFileAccess'],
    apply: setup,
  },
  browser: '/packages/file-preview/src/browser/setup.js',
  browserStyles: ['/packages/file-preview/src/browser/style.css'],
};
