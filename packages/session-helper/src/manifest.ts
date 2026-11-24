import type { PluginDescriptor } from '@mini-harness/plugin-api/descriptor';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: PluginDescriptor = {
  scope: 'application', defaultEnabled: true,
  id: 'session-helper', title: 'Session helper', description: 'Copy messages and edit/resend prompts on a session branch.',
  icon: 'edit', browser: '/packages/session-helper/src/browser/setup.js',
};
