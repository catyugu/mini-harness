import type { BuiltinPlugin } from '../../src/kernel/plugin-api.js';

/** One metadata definition for the host, settings, and browser loader. */
export const manifest: Omit<BuiltinPlugin, 'setup'> = {
  id: 'message-copy', title: 'Copy messages', description: 'Copy the original text of a message.',
  icon: 'copy', browser: '/builtins/message-copy.js', agentResources: false, inject: []
};
