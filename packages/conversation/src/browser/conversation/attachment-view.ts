import { attachmentPlacement, type PreviewResource } from '@mini-harness/file-preview/browser/api';
import type { InputAttachment } from '@mini-harness/input/message';
import type { Context } from 'mini-harness/cordis';
import { fileCard, imageMime } from './attachment-card.ts';

export function attachmentView(
  ctx: Context,
  file: InputAttachment,
  resource: Exclude<PreviewResource, { kind: 'workspace' }> | undefined,
  signal: AbortSignal,
  imageData?: string,
  openSignal = signal,
) {
  const preview = ctx.get('miniFilePreview');
  if (resource && imageMime.test(file.mimeType)) {
    const image = document.createElement('img');
    image.alt = file.name;
    const data = imageData ?? (resource.kind === 'memory' ? resource.data : undefined);
    if (data) image.src = 'data:' + file.mimeType + ';base64,' + data;
    else preview?.thumbnail(resource, image, signal);
    if (!preview && resource.kind === 'memory') return image;
    if (preview) {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'message-image-trigger';
      trigger.setAttribute('aria-label', 'Preview ' + file.name);
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.title = file.name;
      trigger.append(image);
      trigger.onclick = () => ctx.get('miniFilePreview')?.open(resource, 'dialog', openSignal);
      return trigger;
    }
  }

  const card = fileCard(file, Boolean(preview && resource));
  if (card instanceof HTMLButtonElement && resource) {
    card.setAttribute('aria-label', 'Preview ' + file.name);
    const placement = attachmentPlacement(file.name, file.mimeType);
    if (placement === 'dialog') card.setAttribute('aria-haspopup', 'dialog');
    card.onclick = () => ctx.get('miniFilePreview')?.open(resource, placement, openSignal);
  }
  return card;
}
