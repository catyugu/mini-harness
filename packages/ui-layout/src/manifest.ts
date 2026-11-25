import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

export const metadata: PluginInfo = {
  scope: 'application',
  title: 'Layout',
  description: 'Application layout',
  browserStyles: ['./browser/frame.css', './browser/responsive.css', './browser/panels.css'],
  browser: './browser/setup.ts',
};
