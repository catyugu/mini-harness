import { createHash } from 'node:crypto';
import { DomainError } from '@mini-harness/platform/errors';
import type { Attachment, ImageInput } from './message.ts';

export const imageMimeType = /^image\/(png|jpeg|gif|webp)$/;

export function prepareInput(text: unknown, attachments: Attachment[] = []) {
  if (typeof text !== 'string' || text.length > 200000 || (!text.trim() && !attachments?.length))
    throw new DomainError('invalid_input', 'Invalid message');
  if (!Array.isArray(attachments) || attachments.length > 8)
    throw new DomainError('invalid_input', 'Attach at most eight files');
  const userText = text.trim();
  let modelText = text;
  const images: ImageInput[] = [];
  const files: { id: string; bytes: Buffer }[] = [];
  const metadata: { name: string; mimeType: string; id: string; size: number }[] = [];
  let total = 0;
  for (const file of attachments) {
    if (
      !file ||
      typeof file.name !== 'string' ||
      typeof file.mimeType !== 'string' ||
      file.name.length > 200 ||
      /[\x00-\x1f]/.test(file.name) ||
      typeof file.data !== 'string' ||
      file.data.length > 8 * 1024 * 1024 ||
      /[^A-Za-z0-9+/=]/.test(file.data)
    )
      throw new DomainError('invalid_input', 'Invalid attachment');
    const bytes = Buffer.from(file.data, 'base64');
    if (bytes.toString('base64') !== file.data)
      throw new DomainError('invalid_input', 'Invalid attachment encoding');
    total += bytes.length;
    if (total > 12 * 1024 * 1024 || bytes.length > 6 * 1024 * 1024)
      throw new DomainError('invalid_input', 'Attachments exceed 6 MiB per file or 12 MiB per message');
    const id = createHash('sha256').update(bytes).digest('hex');
    files.push({ id, bytes });
    metadata.push({ name: file.name, mimeType: file.mimeType, id, size: bytes.length });
    if (imageMimeType.test(file.mimeType)) {
      const valid =
        file.mimeType === 'image/png'
          ? bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
          : file.mimeType === 'image/jpeg'
            ? bytes.subarray(0, 3).toString('hex') === 'ffd8ff'
            : file.mimeType === 'image/gif'
              ? /^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))
              : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
      if (!valid) throw new DomainError('invalid_input', 'Invalid image: ' + file.name);
      images.push({ type: 'image', mimeType: file.mimeType, data: file.data });
    } else {
      let content: string | undefined;
      if (
        bytes.length <= 1024 * 1024 &&
        !bytes.includes(0) &&
        !/^(?:application\/(?:pdf|zip)|image\/|audio\/|video\/)/.test(file.mimeType)
      ) {
        try {
          content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch {
          /* Non-text files are retained as original uploads. */
        }
      }
      if (content !== undefined)
        modelText += '\n\nAttached file: ' + JSON.stringify(file.name) + '\n' + content;
      else
        modelText +=
          '\n\nUploaded file: ' +
          JSON.stringify(file.name) +
          ' (' +
          bytes.length +
          ' bytes, stored as ' +
          id +
          '). This file is not inlined as text. If Shell is enabled, access it in the directory specified by MINI_HARNESS_ATTACHMENTS.';
    }
  }
  return {
    text: modelText.trim() || 'See attached images.',
    images,
    input: { userText, attachments: metadata },
    files,
  };
}
