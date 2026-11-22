import type { FrontendSetup } from '../kernel/extensions.js';
import { payload } from '../api.js';

const setup: FrontendSetup = (api) => {
  api.messageAction({
    id: 'edit-resend', label: 'Edit message', icon: 'edit', order: 20,
    visible: ({ message, sessionId, leafId }) => message.role === 'user' && !!sessionId && !!message.id && leafId !== undefined,
    run({ message, sessionId, leafId, rawText }) {
      const sourceEntryId = message.id;
      const expectedLeafId = leafId;
      api.beginDraftMode({
        title: 'Editing message · creates a new conversation branch', text: rawText,
        submit: async ({ text, attachments, model, thinkingLevel }) => {
          await api.request('/extensions/edit-resend/revise', payload('POST', {
            sessionId, sourceEntryId, expectedLeafId, message: text, attachments, model, thinkingLevel
          }));
        }
      });
    }
  });
};
export default setup;
