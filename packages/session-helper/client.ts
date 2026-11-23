import type { FrontendSetup } from '#mini-harness/ui-runtime/frontend.js';
import { payload } from '#mini-harness/web/api.js';

/** One Cordis scope owns both message actions and the branch revision draft. */
const setup: FrontendSetup = (_ctx, api) => {
  api.messageAction({
    id: 'session-helper:copy', label: 'Copy message', successLabel: 'Copied', icon: 'copy', order: 10,
    visible: ({ message }) => message.role === 'user' || message.role === 'assistant',
    async run({ rawText }) {
      await navigator.clipboard.writeText(rawText);
    }
  });
  api.messageAction({
    id: 'session-helper:edit', label: 'Edit message', icon: 'edit', order: 20,
    visible: ({ message, sessionId, leafId }) => message.role === 'user' && !!sessionId && !!message.id && leafId !== undefined,
    run({ message, sessionId, leafId, rawText }) {
      const sourceEntryId = message.id;
      const expectedLeafId = leafId;
      api.beginDraftMode({
        title: 'Editing message · creates a new conversation branch', text: rawText,
        submit: async ({ text, attachments, model, thinkingLevel }) => {
          await api.request('/extensions/session-helper/revise', payload('POST', {
            sessionId, sourceEntryId, expectedLeafId, message: text, attachments, model, thinkingLevel
          }));
        }
      });
    }
  });
};
export default setup;
