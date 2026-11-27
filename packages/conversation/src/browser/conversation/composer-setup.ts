import type { Context } from 'mini-harness/cordis';
import { createComposerModel } from './composer-model.ts';
import { mountComposer } from './composer-view.ts';
const setup = (ctx: Context) => {
  const model = createComposerModel(ctx);
  ctx.provide('miniComposer', model);
  ctx.effect(() =>
    ctx.miniSlots.register('conversation.composer-view', (signal) => mountComposer(ctx, signal), {
      key: 'composer',
    }),
  );
};
export default {
  inject: ['miniConversation', 'miniSelection', 'miniSlots', 'miniPrimitives'],
  provide: ['miniComposer'],
  apply: setup,
};
