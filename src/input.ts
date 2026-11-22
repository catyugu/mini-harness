import { TextDecoder } from 'node:util';
import type { Attachment, ImageInput } from './contracts/input.js';
export function prepareInput(text: unknown, attachments: Attachment[] = []) {
  if (typeof text !== 'string' || text.length > 200000 || (!text.trim() && !attachments?.length)) throw new Error('Invalid message');
  if (!Array.isArray(attachments) || attachments.length > 8) throw new Error('Attach at most eight files');
  const images: ImageInput[] = [];
  let total = 0;
  for (const file of attachments) {
    if (!file || typeof file.name !== 'string' || file.name.length > 200 || /[\x00-\x1f]/.test(file.name) ||
      typeof file.data !== 'string' || file.data.length > 8 * 1024 * 1024 || /[^A-Za-z0-9+/=]/.test(file.data))
      throw new Error('Invalid attachment');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data) throw new Error('Invalid attachment encoding');
    total += bytes.length;
    if (total > 12 * 1024 * 1024 || bytes.length > 6 * 1024 * 1024) throw new Error('Attachments exceed 6 MiB per file or 12 MiB per message');
    if (/^image\/(png|jpeg|gif|webp)$/.test(file.mimeType)) {
      const valid = file.mimeType === 'image/png' ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' :
        file.mimeType === 'image/jpeg' ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff' :
        file.mimeType === 'image/gif' ? /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) :
        bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new Error('Invalid image: ' + file.name);
      images.push({ type: 'image', mimeType: file.mimeType, data: file.data });
    } else {
      if (bytes.length > 1024 * 1024 || bytes.includes(0)) throw new Error('Text files must be UTF-8 and at most 1 MiB');
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new Error('Only UTF-8 text and PNG, JPEG, GIF or WebP images are supported'); }
      text += '\n\nAttached file: ' + JSON.stringify(file.name) + '\n' + content;
    }
  }
  return { text: (text as string).trim() || 'See attached images.', images };
}
