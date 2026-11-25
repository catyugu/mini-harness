import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';
import { setup } from './server/setup.ts';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application',
  trustedContributor: true,
  plugin: {
    inject: [
      'harnessState',
      'harnessWorkspaces',
      'harnessSessions',
      'harnessTools',
      'harnessPrompt',
      'harnessScopes',
    ],
    apply: setup,
  },
  defaultEnabled: true,
  id: 'skills',
  title: 'Skills',
  description: 'Discover Agent Skills from home and the workspace.',
  icon: 'skills',
  browser: '/packages/skills/src/browser/setup.js',
};
