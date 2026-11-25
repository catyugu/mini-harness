import { fileRoute, refreshOnFileChange, type WorkspaceView } from '@mini-harness/file-access/browser/views';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import { icon } from '@mini-harness/ui-primitives/icons';
import { button as control, iconButton } from '@mini-harness/ui-primitives/primitives';
import type { Context } from 'mini-harness/cordis';

interface FileEntry {
  name: string;
  directory: boolean;
}

export async function readDirectory(ctx: Context, scope: WorkspaceView, path: string, signal?: AbortSignal) {
  const entries = await browserRequest<FileEntry[]>(ctx, fileRoute(scope, '/files/tree', { path }), {
    signal,
  });
  return entries
    .sort((a, b) => Number(b.directory) - Number(a.directory))
    .map(({ name, directory }) => ({
      name,
      directory,
      path: path === '.' ? name : path + '/' + name,
    }));
}

const base = (path: string) => path.split('/').at(-1) ?? '';
const extension = (path: string) => (base(path).split('.').at(-1) ?? '').toLowerCase();
const code = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'py',
  'rs',
  'go',
  'c',
  'cpp',
  'h',
  'hpp',
  'java',
  'cs',
  'css',
  'html',
  'json',
  'yaml',
  'yml',
  'toml',
  'sh',
  'sql',
]);
const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const documents = new Set(['md', 'markdown', 'txt', 'rst', 'log']);

function fileIcon(path: string) {
  const ext = extension(path);
  return images.has(ext)
    ? 'file-image'
    : code.has(ext)
      ? 'file-code'
      : documents.has(ext)
        ? 'file-text'
        : 'file';
}

function hint(message: string) {
  const node = document.createElement('p');
  node.className = 'hint';
  node.setAttribute('role', 'status');
  node.textContent = message;
  return node;
}

function breadcrumbs(ctx: Context, address: WorkspaceView, path: string, open: (path: string) => void) {
  const node = document.createElement('nav');
  node.className = 'file-breadcrumbs';
  node.setAttribute('aria-label', 'File path');
  const name = ctx.harnessBrowser.workspaceRecord(address.workspaceId)?.name ?? 'Workspace';
  const crumbs = path === '.' ? [] : path.split('/');
  const root = control(name, 'quiet');
  root.onclick = () => open('.');
  if (path === '.') root.setAttribute('aria-current', 'location');
  node.append(root);
  for (const [index, crumb] of crumbs.entries()) {
    const divider = icon('chevron');
    node.append(divider);
    const segment = control(crumb, 'quiet');
    if (index === crumbs.length - 1) segment.setAttribute('aria-current', 'location');
    segment.onclick = () => open(crumbs.slice(0, index + 1).join('/'));
    node.append(segment);
  }
  return node;
}

function fileEntry(ctx: Context, scope: WorkspaceView, path: string, label: string) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'file-entry';
  row.title = path;
  const preview = ctx.get('miniFilePreview');
  row.disabled = !preview;
  row.onclick = () =>
    ctx.get('miniFilePreview')?.open({ kind: 'workspace', workspaceId: scope.workspaceId, path }, 'sidebar');
  row.append(icon(fileIcon(path)));
  const name = document.createElement('span');
  name.textContent = label;
  row.append(name);
  return row;
}

export function fileTree(
  ctx: Context,
  address: WorkspaceView,
  path: string,
  signal: AbortSignal,
  expanded: Set<string>,
  open: (path: string) => void,
) {
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh files', 'refresh');
  toolbar.append(breadcrumbs(ctx, address, path, open), refresh);
  const content = document.createElement('div');
  root.append(toolbar, content);
  let loading: AbortController;
  async function tree(path: string, loadSignal: AbortSignal) {
    const list = document.createElement('div');
    list.className = 'file-tree';
    for (const entry of await readDirectory(ctx, address, path, loadSignal)) {
      if (!entry.directory) {
        list.append(fileEntry(ctx, address, entry.path, entry.name));
        continue;
      }
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      const label = document.createElement('span');
      label.textContent = entry.name;
      summary.append(icon('chevron'), icon('folder'), label);
      summary.title = entry.path;
      details.append(summary);
      list.append(details);
      let pending = false;
      let loaded = false;
      async function expand() {
        if (loadSignal.aborted) return;
        summary.children.item(1)?.replaceWith(icon(details.open ? 'folder-open' : 'folder'));
        if (!details.open) {
          expanded.delete(entry.path);
          return;
        }
        expanded.add(entry.path);
        if (loaded || pending) return;
        pending = true;
        try {
          const branch = await tree(entry.path, loadSignal);
          if (!loadSignal.aborted) {
            details.append(branch);
            loaded = true;
          }
        } catch (error) {
          if (!loadSignal.aborted)
            details.append(hint(error instanceof Error ? error.message : String(error)));
        } finally {
          pending = false;
        }
      }
      details.ontoggle = () => void expand();
      details.open = expanded.has(entry.path);
    }
    if (!list.childElementCount) list.append(hint('Empty directory'));
    return list;
  }
  async function load() {
    loading?.abort();
    loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    content.setAttribute('aria-busy', 'true');
    if (!content.firstChild) content.append(hint('Loading files…'));
    try {
      const listing = await tree(path, loadSignal);
      if (!loadSignal.aborted) content.replaceChildren(listing);
    } catch (error) {
      if (!loadSignal.aborted)
        content.replaceChildren(hint(error instanceof Error ? error.message : String(error)));
    } finally {
      if (!loadSignal.aborted) content.removeAttribute('aria-busy');
    }
  }
  refresh.onclick = () => void load();
  refreshOnFileChange(ctx, address, root, signal, load);
  void load();
  return root;
}
