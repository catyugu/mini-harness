import { conversationExtensions } from '@mini-harness/conversation/browser/extensions';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';

/** One Cordis scope owns both message actions and the branch revision draft. */
const setup: FrontendSetup = (_ctx, api) => {
  api.contribute(conversationExtensions.messageAction, {
    id: 'session-helper:copy', label: 'Copy message', successLabel: 'Copied', icon: 'copy', order: 10,
    visible: ({ message }) => message.role === 'user' || message.role === 'assistant',
    async run({ rawText }) {
      await navigator.clipboard.writeText(rawText);
    }
  });
  api.contribute(conversationExtensions.messageAction, {
    id: 'session-helper:edit', label: 'Edit message', icon: 'edit', order: 20,
    visible: ({ message, sessionId, leafId }) => message.role === 'user' && !!sessionId && !!message.id && leafId !== undefined,
    async run({ message, sessionId, leafId, rawText, signal }) {
      if (!message.id || leafId === undefined || !sessionId) return;
      const sourceEntryId = message.id;
      const expectedLeafId = leafId;
      const files = message.attachments ?? [];
      const imageType = /^image\/(png|jpeg|gif|webp)$/;
      const imageFiles = files.filter(({ mimeType }) => imageType.test(mimeType));
      const textFiles = files.filter(({ mimeType }) => !imageType.test(mimeType));
      const uploads = await Promise.all(textFiles.filter(({ id }) => id).map(async ({ name, mimeType, id }) => {
        const upload = await api.request<{ data: string }>('/sessions/' + sessionId + '/attachments/' + id, { signal });
        return { name, mimeType, data: upload.data };
      }));
      if (signal.aborted || api.signal.aborted) return;
      const missing = textFiles.filter(({ id }) => !id);
      const images = typeof message.content === 'string' ? [] : message.content
        .filter((part): part is typeof part & { mimeType: string; data: string } => part.type === 'image' && !!part.mimeType && !!part.data)
        .map(({ mimeType, data }, index) => ({ name: imageFiles[index]?.name ?? 'Image ' + (index + 1), mimeType, data }));
      api.contribute(conversationExtensions.draft, {
        title: missing.length ? 'Editing a new branch. Reattach: ' + missing.map(({ name }) => name).join(', ')
          : 'Editing message · creates a new conversation branch',
        text: rawText, images, attachments: uploads,
        revision: { sourceEntryId, expectedLeafId }
      });
    }
  });
};
export default setup;
