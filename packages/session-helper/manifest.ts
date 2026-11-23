import type { PluginDescriptor } from '../contracts/plugins.js';
import { setup } from './host.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application',
  setup, defaultEnabled: true, browserRequires: ['core:conversation'],
  id: 'session-helper', title: 'Session helper', description: 'Copy messages and edit/resend prompts on a Pi session branch.',
  icon: 'edit', browser: '/packages/session-helper/client.js', inject: ['harnessRuns', 'harnessRoutes'],
};
