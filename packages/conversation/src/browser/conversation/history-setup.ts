import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { MessageExtensions } from './message-extensions.js';
import { mountHistory } from './history.js';
const setup: FrontendSetup = (ctx, api) => {
  const extensions = new MessageExtensions(ctx.miniConversation.report);
  ctx.provide('miniMessages', extensions);
  api.contribute(slotExtensions.keyed, 'conversation.history', 'history', (signal) => mountHistory(ctx, extensions, signal));
};
export default setup;
