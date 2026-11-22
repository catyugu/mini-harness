import type { BuiltinPlugin } from '../../src/kernel/plugin-api.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'edit-resend', title: 'Edit and resend', description: 'Revise a user message and create a Pi conversation branch.',
  icon: 'edit', browser: '/builtins/edit-resend.js', agentResources: false, inject: ['harnessRevision', 'harnessRoutes'],
};
