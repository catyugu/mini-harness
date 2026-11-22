import type { BuiltinPlugin } from '../../src/kernel/plugin-api.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'session-helper', title: 'Session helper', description: 'Copy messages and edit/resend prompts on a Pi session branch.',
  icon: 'edit', browser: '/features/session-helper/client.js', agentResources: false, inject: ['harnessRevision', 'harnessRoutes'],
};
