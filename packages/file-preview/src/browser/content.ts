import { fileRoute, type WorkspaceView } from '@mini-harness/workspaces/browser/file-views';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import { decodeText, mediaType, textLimit, type PreviewContent } from '../shared/content.ts';
import type { PreviewResource } from './api.ts';

export const nameOf = (resource: PreviewResource) =>
  resource.kind === 'workspace'
    ? (resource.path.replace(/\/$/, '').split('/').at(-1) ?? resource.path)
    : resource.name;

export function bytes(data: string) {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
}

export function blobUrl(data: string, mimeType: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([bytes(data)], { type: mimeType }));
  signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
  return url;
}

async function original(ctx: Context, resource: PreviewResource, scope: WorkspaceView, signal: AbortSignal) {
  if (resource.kind === 'memory') return resource.data;
  const path =
    resource.kind === 'workspace'
      ? fileRoute(scope, '/files/download', { path: resource.path })
      : `/sessions/${encodeURIComponent(resource.sessionId)}/attachments/${encodeURIComponent(resource.id)}`;
  return (await browserRequest<{ data: string }>(ctx, path, { signal })).data;
}

export async function fetchContent(
  ctx: Context,
  resource: PreviewResource,
  scope: WorkspaceView,
  signal: AbortSignal,
): Promise<PreviewContent> {
  if (resource.kind === 'workspace')
    return browserRequest(ctx, fileRoute(scope, '/files/preview', { path: resource.path }), { signal });
  const data = await original(ctx, resource, scope, signal);
  const mimeType = mediaType(resource.name, resource.mimeType);
  if (mimeType) return { kind: 'bytes', data, mimeType };
  const raw = bytes(data);
  const text = decodeText(raw.subarray(0, textLimit));
  return text === undefined ? { kind: 'binary' } : { kind: 'text', text, truncated: raw.length > textLimit };
}

export async function download(
  ctx: Context,
  resource: PreviewResource,
  scope: WorkspaceView,
  signal: AbortSignal,
) {
  const data = await original(ctx, resource, scope, signal);
  signal.throwIfAborted();
  const url = URL.createObjectURL(new Blob([bytes(data)], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = nameOf(resource);
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
