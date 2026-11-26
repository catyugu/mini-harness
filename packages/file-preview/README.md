# File Preview

Previews and downloads workspace files and conversation attachments. It owns preview rendering, media dialogs and their browser resources. File Access owns workspace reads, Sessions owns stored attachment bytes, and UI Layout owns workspace tabs.

## Activation and public API

The [web Profile](../../profiles/web.yml) enables `@mini-harness/file-preview` as `file-preview`. It has no configuration. The server injects Routes, Workspaces, Profile Scopes and File Access; the browser injects `miniTabs` and `miniProjections`, with file-tree navigation used when available.

Browser plugins import [`mini-harness/file-preview`](src/browser/api.ts) and inject `miniFilePreview`. `open(resource, placement)` takes a typed `PreviewResource` and either `sidebar` or `dialog`:

| Resource     | Identity and content owner                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `workspace`  | Workspace ID and relative path, read through the selected File Access provider.                                     |
| `attachment` | Workspace ID, original session ID and stored attachment ID, with a name and MIME type. Sessions supplies the bytes. |
| `memory`     | Workspace ID, caller-selected stable key, base64 data, name, MIME type and an abort signal owned by the caller.     |

Inside a browser plugin with a workspace ID, a text file can be opened with:

```ts
ctx.miniFilePreview.open({ kind: 'workspace', workspaceId, path: 'README.md' }, 'sidebar');
```

Use `attachmentPlacement(name, mimeType)` to choose the default placement: supported image and video media use a dialog, and other content uses the sidebar. Passing `dialog` for content without a media preview displays a download fallback.

## Reads and presentation

The [server routes](src/server/setup.ts) expose `GET /api/workspaces/:id/files/preview` and `/files/download` with a `path` query parameter. They resolve the registered workspace and configured File Access provider before reading. Stored attachments continue to use the Sessions attachment route and retain their original session identity across navigation.

Text previews are bounded, decoded as UTF-8 and marked when truncated. Markdown can switch between the sanitized rendered view and source. Images and videos use recognized media types; unsupported binary content offers download. Workspace downloads are bounded separately. See [`shared/content.ts`](src/shared/content.ts) for supported formats and byte limits, and [`source.ts`](src/browser/source.ts) for display-line limits.

## View lifetime and failures

A sidebar resource is keyed within its workspace. Reopening it selects the existing tab. Workspace previews refresh on the shared file invalidation projection, tab activation, window focus and explicit refresh; external processes do not provide a continuous filesystem-watch guarantee.

Only one media dialog is active per preview plugin. Opening another or changing workspaces closes it. Closing a view cancels its requests and revokes media object URLs. Aborting a `memory` resource's caller signal also closes its tab or dialog; persistent attachments remain Sessions-owned and are not deleted by closing their preview.

Read failures and unsupported media are presented in the view. Source content is rendered as text, and Markdown uses the shared sanitized renderer. This package provides read-only inspection, not a file editor.

## Verification

[File-view tests](../../test/browser/files.spec.ts) cover workspace previews, downloads, refresh and responsive panels. [Conversation tests](../../test/browser/conversation.spec.ts) cover media attachments; [message-action tests](../../test/browser/message-actions.spec.ts) exercise attachment identity and draft lifetime.

See [Files](../files/README.md) for browsing and editing, [Git Diff](../git-diff/README.md) for repository changes, and [frontend composition](../../docs/subsystems/frontend.md).
