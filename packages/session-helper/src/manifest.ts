import type { PluginInfo } from '@mini-harness/plugin-api/descriptor';

/** One metadata definition for the host, settings, and browser loader. */
export const metadata: PluginInfo = {
  title: 'Session helper',
  description: 'Copy messages and edit/resend prompts on a session branch.',
  icon: 'edit',
  browser: 'packages/session-helper/src/browser/setup.js',
};
