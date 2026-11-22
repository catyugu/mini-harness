import type { BuiltinPlugin } from '../kernel/plugin-api.js';

/** Pure browser contribution: no backend routes and no backend tools. */
export const messageCopy: BuiltinPlugin = {
  id: 'message-copy', title: 'Copy messages', description: 'Copy the original text of a message.',
  icon: 'copy', browser: '/builtins/message-copy.js', inject: []
};
