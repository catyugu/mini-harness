import { MessageExtensions } from './message-extensions.js';
import type { Context } from 'mini-harness/cordis';
import { mountHistory } from './history.js';
const setup = (ctx: Context) => {
  const extensions = new MessageExtensions();
  ctx.provide('miniMessages', extensions);
  ctx.effect(() =>
    ctx.miniSlots.registerKeyed(
      'conversation.history',
      'history',
      (signal) => mountHistory(ctx, extensions, signal),
      { order: -1 },
    ),
  );
};
export default {
  inject: ['miniConversation', 'miniComposer', 'miniSlots'],
  provide: ['miniMessages'],
  apply: setup,
};
