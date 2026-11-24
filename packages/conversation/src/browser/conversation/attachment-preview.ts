import type { InputAttachment } from '@mini-harness/input/message';
import type { TabAddress } from '@mini-harness/ui-layout/browser/api';
import { button } from '@mini-harness/ui-primitives/primitives';
import { textPreview } from '@mini-harness/ui-primitives/file-preview';
import { data } from '@mini-harness/ui-runtime/http';
import { imageMime } from './attachment-card.js';

export function mediaType(file: InputAttachment): string | undefined {
  if (imageMime.test(file.mimeType) || /^video\/(?:mp4|webm|ogg|quicktime|x-m4v)$/.test(file.mimeType)) return file.mimeType;
  if (/\.(?:mp4|m4v)$/i.test(file.name)) return 'video/mp4';
  if (/\.webm$/i.test(file.name)) return 'video/webm';
  if (/\.ogv$/i.test(file.name)) return 'video/ogg';
  if (/\.mov$/i.test(file.name)) return 'video/quicktime';
}

export async function readUpload(sessionId: string, id: string, signal: AbortSignal) {
  const upload = await data<{ data: string }>('/sessions/' + sessionId + '/attachments/' + id, { signal });
  return Uint8Array.from(atob(upload.data), (char) => char.charCodeAt(0));
}

export function attachmentName(path: string) { return path.slice(path.indexOf('/') + 1); }

export function attachmentView(address: TabAddress, signal: AbortSignal) {
  const path = address.path!;
  const id = path.slice(0, path.indexOf('/'));
  const name = attachmentName(path);
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'attachment-preview-toolbar';
  const title = document.createElement('strong'); title.textContent = name; title.title = name;
  const raw = button('Source', 'quiet'); raw.hidden = true;
  const download = button('Download', 'quiet'); download.disabled = true;
  toolbar.append(title, raw, download);
  const body = document.createElement('div'); body.textContent = 'Loading attachment…';
  root.append(toolbar, body);
  void readUpload(address.sessionId!, id, signal).then((bytes) => {
    if (signal.aborted) return;
    download.disabled = false;
    download.onclick = () => {
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
    let text: string | undefined;
    if (!bytes.includes(0)) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* Binary upload. */ }
    }
    if (text === undefined || /\.(?:pdf|zip|docx|xlsx|pptx)$/i.test(name)) {
      body.textContent = 'Preview is unavailable for this file. Download the original to open it.';
      return;
    }
    const limit = 512 * 1024;
    body.replaceChildren(textPreview(name, text.slice(0, limit), raw));
    if (text.length > limit) {
      const note = document.createElement('p'); note.className = 'hint';
      note.textContent = 'Preview is truncated. Download the original to read the complete file.';
      body.append(note);
    }
  }).catch((error) => { if (!signal.aborted) body.textContent = error instanceof Error ? error.message : String(error); });
  return root;
}
