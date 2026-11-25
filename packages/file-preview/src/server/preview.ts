import type { RootedFileAccess } from '@mini-harness/file-access/api';
import { DomainError } from '@mini-harness/platform/errors';
import {
  decodeText,
  mediaType,
  textLimit,
  workspaceReadLimit,
  type PreviewContent,
} from '../shared/content.ts';

export async function workspacePreview(
  files: RootedFileAccess,
  path: string,
  signal: AbortSignal,
): Promise<PreviewContent> {
  const info = await files.stat(path);
  if (info.isDirectory()) return { kind: 'directory' };
  const mimeType = mediaType(path);
  const limit = mimeType ? workspaceReadLimit : textLimit;
  const chunks: Uint8Array[] = [];
  let remaining = limit;
  let truncated = false;
  for await (const chunk of files.chunks(path, signal)) {
    const part = chunk.subarray(0, remaining);
    chunks.push(part);
    remaining -= part.length;
    if (part.length < chunk.length) {
      truncated = true;
      break;
    }
  }
  const bytes = Buffer.concat(chunks);
  if (mimeType) {
    // File Access chunks are bounded. Never pass a partial media resource to the decoder.
    if (truncated || (info.size ?? bytes.length) > limit) return { kind: 'binary' };
    return { kind: 'bytes', mimeType, data: bytes.toString('base64') };
  }
  const text = decodeText(bytes);
  return text === undefined ? { kind: 'binary' } : { kind: 'text', text, truncated };
}

export async function downloadWorkspaceFile(files: RootedFileAccess, path: string, signal: AbortSignal) {
  const bytes = await files.readFile(path);
  signal.throwIfAborted();
  if (bytes.length > workspaceReadLimit)
    throw new DomainError('invalid_input', 'File exceeds the 16 MiB download limit');
  return { data: bytes.toString('base64') };
}
