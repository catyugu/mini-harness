import { button, iconButton } from '@mini-harness/ui-primitives/primitives';
import { imageMime } from '../shared/content.ts';
import { blobUrl } from './content.ts';

export function mediaElement(data: string, mimeType: string, name: string, signal: AbortSignal) {
  const media = imageMime.test(mimeType) ? document.createElement('img') : document.createElement('video');
  media.className = 'file-preview-media';
  if (media instanceof HTMLImageElement) media.alt = name;
  else {
    media.controls = true;
    media.playsInline = true;
    media.setAttribute('aria-label', name);
    signal.addEventListener(
      'abort',
      () => {
        media.pause();
        media.removeAttribute('src');
        media.load();
      },
      { once: true },
    );
  }
  media.src = blobUrl(data, mimeType, signal);
  return media;
}

export function mediaDialog(name: string, signal: AbortSignal) {
  const restore = document.activeElement;
  const controller = new AbortController();
  const lifetime = AbortSignal.any([signal, controller.signal]);
  const dialog = document.createElement('dialog');
  dialog.className = 'file-media-dialog';
  dialog.setAttribute('aria-label', name);
  const viewport = document.createElement('div');
  viewport.className = 'file-media-viewport';
  const content = document.createElement('div');
  content.className = 'file-media-content';
  const controls = document.createElement('div');
  controls.className = 'file-media-controls';
  const close = iconButton('Close preview', 'close');
  close.onclick = () => controller.abort();
  controls.append(close);
  content.textContent = 'Loading preview…';
  viewport.append(content);
  dialog.append(viewport, controls);
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    controller.abort();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) controller.abort();
  });
  lifetime.addEventListener(
    'abort',
    () => {
      dialog.close();
      dialog.remove();
      if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
    },
    { once: true },
  );
  document.body.append(dialog);
  dialog.showModal();
  close.focus();
  return {
    signal: lifetime,
    content,
    close: () => controller.abort(),
    show(media: HTMLImageElement | HTMLVideoElement) {
      content.replaceChildren(media);
      if (media instanceof HTMLImageElement) {
        const actual = button('Actual size', 'quiet');
        actual.setAttribute('aria-pressed', 'false');
        actual.onclick = () => {
          const expanded = viewport.classList.toggle('actual-size');
          actual.textContent = expanded ? 'Fit to window' : 'Actual size';
          actual.setAttribute('aria-pressed', String(expanded));
        };
        controls.prepend(actual);
      }
    },
  };
}
