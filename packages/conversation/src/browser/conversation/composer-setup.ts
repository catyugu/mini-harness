import type { Context } from 'mini-harness/cordis';
import { createComposerModel } from './composer-model.js';
import { mountComposer } from './composer-view.js';
const setup = (ctx: Context) => {
  const model = createComposerModel(ctx);
  ctx.provide('miniComposer', model);
  ctx.effect(() => ctx.miniSlots.registerKeyed('conversation.composer-view', 'composer', (signal) => mountComposer(ctx, signal), { order: -1 }));
};
export default { inject: ['miniConversation','miniSelection','miniModels','miniSlots'], provide: ['miniComposer'], apply: setup };
