import { refreshOnFileChange, type WorkspaceView } from '@mini-harness/workspaces/browser/file-views';
import { renderMarkdown } from '@mini-harness/ui-primitives/markdown';
import { button, iconButton } from '@mini-harness/ui-primitives/primitives';
import type { Context } from 'mini-harness/cordis';
import { codeExtensions, extension, imageMime, mediaType } from '../shared/content.ts';
import type { PreviewPlacement, PreviewResource } from './api.ts';
import { blobUrl, download, fetchContent, nameOf } from './content.ts';
import { mediaDialog, mediaElement } from './media.ts';
import { source } from './source.ts';

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function downloadButton(
  ctx: Context,
  resource: PreviewResource,
  scope: WorkspaceView,
  signal: AbortSignal,
  status: HTMLElement,
) {
  const trigger = button('Download', 'quiet');
  trigger.onclick = async () => {
    trigger.disabled = true;
    try {
      await download(ctx, resource, scope, signal);
    } catch (error) {
      if (!signal.aborted) status.textContent = errorText(error);
    } finally {
      trigger.disabled = false;
    }
  };
  return trigger;
}

function sidebar(ctx: Context, resource: PreviewResource, scope: WorkspaceView, signal: AbortSignal) {
  const name = nameOf(resource);
  const root = document.createElement('section');
  const toolbar = document.createElement('header');
  toolbar.className = 'file-preview-header';
  const label = document.createElement('strong');
  label.textContent = name;
  label.title = resource.kind === 'workspace' ? resource.path : name;
  const raw = button('Source', 'quiet');
  raw.hidden = true;
  const refresh = iconButton('Refresh file', 'refresh');
  refresh.hidden = resource.kind !== 'workspace';
  const status = document.createElement('p');
  status.className = 'hint';
  status.setAttribute('role', 'status');
  const save = downloadButton(ctx, resource, scope, signal, status);
  toolbar.append(label, raw, save, refresh);
  const content = document.createElement('div');
  root.append(toolbar, status, content);
  let request: AbortController;
  let showSource = false;

  async function load() {
    request?.abort();
    request = new AbortController();
    const lifetime = AbortSignal.any([signal, request.signal]);
    status.textContent = 'Loading file…';
    raw.hidden = save.hidden = true;
    content.replaceChildren();
    try {
      const preview = await fetchContent(ctx, resource, scope, lifetime);
      if (lifetime.aborted) return;
      status.textContent = '';
      save.hidden = preview.kind === 'directory';
      if (preview.kind === 'directory') {
        const files = ctx.get('miniFileTree');
        if (resource.kind === 'workspace' && files) {
          const browse = button('Browse directory', 'quiet');
          browse.onclick = () => files.open(resource.path, scope);
          content.append(browse);
        } else status.textContent = 'Workspace file browsing is unavailable.';
      } else if (preview.kind === 'bytes') {
        const media = mediaElement(preview.data, preview.mimeType, name, lifetime);
        media.addEventListener(
          'error',
          () => {
            status.textContent = 'This media could not be played. You can download the original file.';
          },
          { signal: lifetime },
        );
        content.append(media);
      } else if (preview.kind === 'binary') {
        status.textContent = 'Preview unavailable for this file.';
      } else {
        const ext = extension(name);
        const code = source(preview.text, codeExtensions.has(ext));
        content.append(code);
        if (ext === 'md' || ext === 'markdown') {
          const markdown = document.createElement('div');
          renderMarkdown(markdown, preview.text);
          content.append(markdown);
          raw.hidden = false;
          const toggle = () => {
            code.hidden = !showSource;
            markdown.hidden = showSource;
            raw.setAttribute('aria-pressed', String(showSource));
          };
          raw.onclick = () => {
            showSource = !showSource;
            toggle();
          };
          toggle();
        }
        if (preview.truncated) status.textContent = 'Preview shows the first 512 KiB.';
      }
    } catch (error) {
      if (!lifetime.aborted) status.textContent = errorText(error);
    }
  }
  refresh.onclick = () => void load();
  if (resource.kind === 'workspace') refreshOnFileChange(ctx, scope, root, signal, load);
  void load();
  return root;
}

function setup(ctx: Context) {
  const lifetime = ctx.fiber.signal;
  const tab = ctx.miniTabs.register<PreviewResource>('preview', {
    title: nameOf,
    create: (resource, scope, signal) => sidebar(ctx, resource, scope, signal),
  });
  let active: ReturnType<typeof mediaDialog> | undefined;
  ctx.provide('miniFilePreview', {
    open(resource: PreviewResource, placement: PreviewPlacement, caller?: AbortSignal) {
      if (lifetime.aborted) return;
      if (resource.kind === 'workspace' && resource.path.endsWith('/')) {
        const files = ctx.get('miniFileTree');
        if (files) {
          files.open(resource.path.replace(/\/$/, '') || '.', { workspaceId: resource.workspaceId });
          return;
        }
      }
      const workspaceId = resource.workspaceId;
      const sessionId = resource.kind === 'workspace' ? undefined : resource.sessionId;
      const scope = { workspaceId, sessionId };
      const signals = [lifetime];
      if (caller) signals.push(caller);
      if (resource.kind === 'memory') signals.push(resource.signal);
      const signal = AbortSignal.any(signals);
      if (signal.aborted) return;
      if (placement === 'sidebar') {
        const key =
          resource.kind === 'workspace'
            ? resource.path
            : resource.kind === 'attachment'
              ? resource.sessionId + ':' + resource.id
              : resource.key;
        tab.open({
          owner: { workspaceId },
          key: resource.kind + ':' + key,
          data: resource,
          signal,
        });
        return;
      }

      active?.close();
      const dialog = (active = mediaDialog(nameOf(resource), signal));
      dialog.signal.addEventListener(
        'abort',
        () => {
          if (active === dialog) active = undefined;
        },
        { once: true },
      );
      ctx.miniTabs.onWorkspaceChange(() => dialog.close(), dialog.signal);
      const status = document.createElement('p');
      status.setAttribute('role', 'status');
      const failure = (message: string) => {
        status.textContent = message;
        dialog.content.replaceChildren(status, downloadButton(ctx, resource, scope, dialog.signal, status));
      };
      void fetchContent(ctx, resource, scope, dialog.signal)
        .then((preview) => {
          if (dialog.signal.aborted) return;
          if (preview.kind !== 'bytes') {
            failure('This file has no media preview.');
            return;
          }
          const media = mediaElement(preview.data, preview.mimeType, nameOf(resource), dialog.signal);
          media.addEventListener(
            'error',
            () => failure('This media could not be played. You can download the original file.'),
            { signal: dialog.signal },
          );
          dialog.show(media);
        })
        .catch((error) => {
          if (!dialog.signal.aborted) failure(errorText(error));
        });
    },
    thumbnail(
      resource: Exclude<PreviewResource, { kind: 'workspace' }>,
      image: HTMLImageElement,
      caller: AbortSignal,
    ) {
      const mimeType = mediaType(resource.name, resource.mimeType);
      if (!mimeType || !imageMime.test(mimeType)) return;
      const signal = AbortSignal.any(
        resource.kind === 'memory' ? [caller, lifetime, resource.signal] : [caller, lifetime],
      );
      const scope = { workspaceId: resource.workspaceId, sessionId: resource.sessionId };
      void fetchContent(ctx, resource, scope, signal)
        .then((preview) => {
          if (!signal.aborted && preview.kind === 'bytes')
            image.src = blobUrl(preview.data, mimeType, signal);
        })
        .catch(() => {
          if (!signal.aborted) image.classList.add('thumbnail-unavailable');
        });
    },
  });
}

export default { inject: ['miniTabs', 'miniProjections'], provide: ['miniFilePreview'], apply: setup };
