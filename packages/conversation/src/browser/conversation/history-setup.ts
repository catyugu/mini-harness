import { MessageExtensions } from './message-extensions.ts';
import type { Context } from 'mini-harness/cordis';
import { mountHistory } from './history.ts';
const setup = (ctx: Context) => {
  const extensions = new MessageExtensions();
  ctx.provide('miniMessages', extensions);
  ctx.effect(() =>
    ctx.miniSlots.registerKeyed('conversation.history', 'history', (signal) =>
      mountHistory(ctx, extensions, signal),
    ),
  );
};
export default {
  inject: ['miniConversation', 'miniComposer', 'miniSlots'],
  provide: ['miniMessages'],
  apply: setup,
};
