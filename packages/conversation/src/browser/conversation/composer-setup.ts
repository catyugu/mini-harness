import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { createComposerModel } from './composer-model.js';
import { mountComposer } from './composer-view.js';
const setup: FrontendSetup = (ctx, api) => {
  const model = createComposerModel(ctx, api);
  ctx.provide('miniComposer', model);
  api.contribute(slotExtensions.keyed, 'conversation.composer-view', 'composer', (signal) => mountComposer(ctx, model, signal));
};
export default setup;
