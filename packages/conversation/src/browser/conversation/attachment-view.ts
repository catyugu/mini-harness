import { attachmentPlacement, type PreviewResource } from '@mini-harness/file-preview/browser/api';
import type { ViewAttachment } from '@mini-harness/sessions/message';
import type { Context } from 'mini-harness/cordis';
import { rasterImage } from '@mini-harness/ui-primitives/primitives';
import { fileCard } from './attachment-card.ts';

export function attachmentView(ctx: Context, file: ViewAttachment, resource?: PreviewResource) {
  const preview = ctx.get('miniFilePreview');
  const open =
    preview && resource
      ? () => preview.open(resource, attachmentPlacement(file.name, file.mimeType))
      : undefined;
  let node: HTMLElement;
  const image = rasterImage(file.mimeType, file.data, file.name);
  if (image) {
    if (!open) return image;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'message-image-trigger';
    trigger.title = file.name;
    trigger.append(image);
    node = trigger;
  } else node = fileCard(file, Boolean(open));

  if (node instanceof HTMLButtonElement && open) {
    node.setAttribute('aria-label', 'Preview ' + file.name);
    if (attachmentPlacement(file.name, file.mimeType) === 'dialog')
      node.setAttribute('aria-haspopup', 'dialog');
    node.onclick = open;
  }
  return node;
}
