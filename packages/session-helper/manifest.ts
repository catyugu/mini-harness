import type { PluginDescriptor } from '@mini-harness/contracts/plugins';
import { setup } from './host.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application', browserInject: ['miniMessages', 'miniComposer'],
  setup, defaultEnabled: true,
  id: 'session-helper', title: 'Session helper', description: 'Copy messages and edit/resend prompts on a session branch.',
  icon: 'edit', browser: '/packages/session-helper/client.js', inject: ['harnessRuns', 'harnessRoutes'],
};
