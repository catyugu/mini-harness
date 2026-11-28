import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';

/** One Cordis scope owns both message actions and the branch revision draft. */
const setup = (ctx: Context) => {
  ctx.effect(() =>
    ctx.miniMessages.registerAction({
      id: 'session-helper:copy',
      label: 'Copy message',
      successLabel: 'Copied',
      icon: 'copy',
      order: 10,
      visible: ({ target }) => Boolean(target.rawText),
      async run({ target }) {
        await navigator.clipboard.writeText(target.rawText);
      },
    }),
  );
  ctx.effect(() =>
    ctx.miniMessages.registerAction({
      id: 'session-helper:edit',
      label: 'Edit message',
      icon: 'edit',
      order: 20,
      visible: ({ target, leafId }) => target.type === 'user-message' && leafId !== undefined,
      async run({ target, sessionId, leafId, signal }) {
        if (target.type !== 'user-message' || leafId === undefined) return;
        const { message, rawText } = target;
        const sourceEntryId = message.id;
        const expectedLeafId = leafId;
        const files = message.attachments;
        const imageType = /^image\/(png|jpeg|gif|webp)$/;
        const imageFiles = files.filter(({ mimeType }) => imageType.test(mimeType));
        const textFiles = files.filter(({ mimeType }) => !imageType.test(mimeType));
        const uploads = await Promise.all(
          textFiles
            .filter(({ id }) => id)
            .map(async ({ name, mimeType, id }) => {
              const upload = await browserRequest<{ data: string }>(
                ctx,
                '/sessions/' + sessionId + '/attachments/' + id,
                { signal },
              );
              return { name, mimeType, data: upload.data };
            }),
        );
        if (signal.aborted) return;
        const missing = textFiles.filter(({ id }) => !id);
        const images = imageFiles.flatMap(({ name, mimeType, data }) =>
          data ? [{ name, mimeType, data }] : [],
        );
        ctx.effect(() =>
          ctx.miniComposer.beginDraftMode({
            title: missing.length
              ? 'Editing a new branch. Reattach: ' + missing.map(({ name }) => name).join(', ')
              : 'Editing message · creates a new conversation branch',
            text: rawText,
            images,
            attachments: uploads,
            revision: { sourceEntryId, expectedLeafId },
          }),
        );
      },
    }),
  );
};
export default { inject: ['miniMessages', 'miniComposer'], provide: [], apply: setup };
