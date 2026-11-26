import { createHash } from 'node:crypto';
import type { PreparedMessage } from '@mini-harness/input/message';
import type { NativeUserMessage } from '@mini-harness/llm/api';
import type { ViewAttachment } from './shared/message.ts';

export function userContent(content: NativeUserMessage['content'], presentation?: PreparedMessage) {
  const blocks = typeof content === 'string' ? [] : content;
  const images = presentation?.images ?? blocks.filter((part) => part.type === 'image');
  const identities = images.map(
    ({ data, mimeType }) =>
      [
        createHash('sha256').update(data, 'base64').digest('hex') + ':' + mimeType,
        { data, mimeType },
      ] as const,
  );
  const byId = new Map(identities);
  const matched = new Set<string>();
  const attachments: ViewAttachment[] = (presentation?.attachments ?? []).map((file) => {
    const key = file.id + ':' + file.mimeType;
    const image = byId.get(key);
    if (!image) return file;
    matched.add(key);
    return { ...file, data: image.data };
  });
  for (const [key, image] of identities)
    if (!matched.has(key)) attachments.push({ ...image, name: 'Image ' + (attachments.length + 1) });
  return {
    content:
      presentation?.userText ??
      (typeof content === 'string' ? content : blocks.filter((part) => part.type === 'text')),
    attachments,
  };
}
