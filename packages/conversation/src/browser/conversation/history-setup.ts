import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { MessageExtensions } from './message-extensions.js';
import { mountHistory } from './history.js';
import { layoutExtensions } from '@mini-harness/ui-layout/browser/api';
import { attachmentView, attachmentName } from './attachment-preview.js';
const setup: FrontendSetup = (ctx, api) => {
  const extensions = new MessageExtensions();
  ctx.provide('miniMessages', extensions);
  api.contribute(layoutExtensions.tab, 'attachment', {
    title: ({ path }) => attachmentName(path!),
    sessionScoped: true,
    create: attachmentView
  });
  api.contribute(slotExtensions.keyed, 'conversation.history', 'history', (signal) =>
    mountHistory(ctx, extensions, signal, (path) => api.contribute(layoutExtensions.openTab, 'attachment', path)));
};
export default setup;
