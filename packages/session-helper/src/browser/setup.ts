import { conversationExtensions } from '@mini-harness/conversation/browser/composer-api';
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
    run({ message, sessionId, leafId, rawText }) {
      if (!message.id || leafId === undefined || !sessionId) return;
      const sourceEntryId = message.id;
      const expectedLeafId = leafId;
      const files = message.attachments ?? [];
      const imageType = /^image\/(png|jpeg|gif|webp)$/;
      const imageFiles = files.filter(({ mimeType }) => imageType.test(mimeType));
      const textFiles = files.filter(({ mimeType }) => !imageType.test(mimeType));
      const images = typeof message.content === 'string' ? [] : message.content
        .filter((part): part is typeof part & { mimeType: string; data: string } => part.type === 'image' && !!part.mimeType && !!part.data)
        .map(({ mimeType, data }, index) => ({ name: imageFiles[index]?.name ?? 'Image ' + (index + 1), mimeType, data }));
      api.contribute(conversationExtensions.draft, {
        title: textFiles.length ? 'Editing a new branch. Reattach: ' + textFiles.map(({ name }) => name).join(', ')
          : 'Editing message · creates a new conversation branch',
        text: rawText, images,
        revision: { sourceEntryId, expectedLeafId }
      });
    }
  });
};
export default setup;
