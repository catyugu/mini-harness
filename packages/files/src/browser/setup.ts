import type { Suggestion } from '@mini-harness/conversation/browser/composer-api';
import { conversationExtensions } from '@mini-harness/conversation/browser/extensions';
import { layoutExtensions, type TabAddress, type TabScope } from '@mini-harness/ui-layout/browser/api';
import type { FrontendApi, FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import type { ConversationBrowserPort } from '@mini-harness/conversation/browser/navigation-api';
import type { BrowserProjectionPort } from '@mini-harness/ui-runtime/projection-api';
import { icon } from '@mini-harness/ui-primitives/icons';
import { button as control, iconButton } from '@mini-harness/ui-primitives/primitives';
import { workspaceRoute } from '@mini-harness/workspaces/browser/route';
import { wait } from '@mini-harness/ui-runtime/http';
import { textPreview } from '@mini-harness/ui-primitives/file-preview';

interface FileEntry { name: string; directory: boolean }
interface FileChange { path: string; status: string }
interface GitChanges { available: boolean; files: FileChange[]; truncated?: boolean; reason?: string }
interface Preview { content: string; image?: string; video?: string; truncated?: boolean }

function fileRoute(scope: TabScope, action: string, query: Record<string, string> = {}) {
  const params = new URLSearchParams(query);
  if (scope.sessionId) params.set('sessionId', scope.sessionId);
  return workspaceRoute(scope.workspaceId, '/files/' + action) + '?' + params;
}

async function readDirectory(api: FrontendApi, scope: TabScope, path: string, signal?: AbortSignal) {
  const entries = await api.request<FileEntry[]>(fileRoute(scope, 'tree', { path }), { signal });
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory)).map(({ name, directory }) => ({
    name, directory, path: path === '.' ? name : path + '/' + name
  }));
}

const base = (path: string) => path.split('/').at(-1) ?? '';
const extension = (path: string) => (base(path).split('.').at(-1) ?? '').toLowerCase();
const code = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'py', 'rs', 'go', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'css', 'html', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql']);
const images = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);
const documents = new Set(['md', 'markdown', 'txt', 'rst', 'log']);

function fileIcon(path: string) {
  const ext = extension(path);
  return images.has(ext) ? 'file-image' : code.has(ext) ? 'file-code' : documents.has(ext) ? 'file-text' : 'file';
}

function hint(message: string) {
  const node = document.createElement('p');
  node.className = 'hint';
  node.setAttribute('role', 'status');
  node.textContent = message;
  return node;
}

function breadcrumbs(api: FrontendApi, services: ConversationBrowserPort, address: TabAddress, path: string, leaf = false) {
  const node = document.createElement('nav');
  node.className = 'file-breadcrumbs';
  node.setAttribute('aria-label', 'File path');
  const name = services.workspaceRecord(address.workspaceId)?.name ?? 'Workspace';
  const crumbs = path === '.' ? [] : path.split('/');
  const root = control(name, 'quiet');
  const open = (path?: string) => api.contribute(layoutExtensions.openTab, 'files', path, address);
  root.onclick = () => open();
  if (path === '.') root.setAttribute('aria-current', 'location');
  node.append(root);
  for (const [index, crumb] of crumbs.entries()) {
    const divider = icon('chevron');
    node.append(divider);
    if (index === crumbs.length - 1 && leaf) {
      const label = document.createElement('span');
      label.textContent = crumb;
      label.setAttribute('aria-current', 'location');
      node.append(label);
    } else {
      const segment = control(crumb, 'quiet');
      if (index === crumbs.length - 1) segment.setAttribute('aria-current', 'location');
      segment.onclick = () => open(crumbs.slice(0, index + 1).join('/'));
      node.append(segment);
    }
  }
  return node;
}

function fileEntry(api: FrontendApi, scope: TabScope, path: string, label: string, status?: string, type: 'file' | 'diff' = 'file') {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'file-entry';
  row.title = path;
  row.onclick = () => api.contribute(layoutExtensions.openTab, type, path, scope);
  row.append(icon(fileIcon(path)));
  const name = document.createElement('span');
  name.textContent = label;
  row.append(name);
  if (status) {
    const change = document.createElement('small');
    change.className = 'file-status';
    change.textContent = status.trim();
    change.title = 'Git status ' + status.trim();
    row.append(change);
  }
  return row;
}

function refreshFiles(projections: BrowserProjectionPort, address: TabAddress, root: HTMLElement, signal: AbortSignal, load: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 60);
  };
  const release = projections.register('files', {
    sync(_revision, reconnect, workspaceId) {
      if (reconnect || !workspaceId || workspaceId === address.workspaceId) schedule();
    }
  });
  window.addEventListener('focus', schedule, { signal });
  root.addEventListener('tab-activate', schedule, { signal });
  signal.addEventListener('abort', () => { clearTimeout(timer); release(); }, { once: true });
  schedule();
}

function fileTree(projections: BrowserProjectionPort, api: FrontendApi, services: ConversationBrowserPort, address: TabAddress, signal: AbortSignal, expanded: Set<string>) {
  const path = address.path ?? '.';
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh files', 'refresh');
  toolbar.append(breadcrumbs(api, services, address, path), refresh);
  const content = document.createElement('div');
  root.append(toolbar, content);
  let loading: AbortController;
  async function tree(path: string, loadSignal: AbortSignal) {
    const list = document.createElement('div');
    list.className = 'file-tree';
    for (const entry of await readDirectory(api, address, path, loadSignal)) {
      if (!entry.directory) {
        list.append(fileEntry(api, address, entry.path, entry.name));
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
        if (!details.open) { expanded.delete(entry.path); return; }
        expanded.add(entry.path);
        if (loaded || pending) return;
        pending = true;
        try {
          const branch = await tree(entry.path, loadSignal);
          if (!loadSignal.aborted) { details.append(branch); loaded = true; }
        } catch (error) { if (!loadSignal.aborted) details.append(hint((error instanceof Error ? error.message : String(error)))); }
        finally { pending = false; }
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
    } catch (error) { if (!loadSignal.aborted) content.replaceChildren(hint((error instanceof Error ? error.message : String(error)))); }
    finally { if (!loadSignal.aborted) content.removeAttribute('aria-busy'); }
  }
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

/** Git changes are a separate root view, never a mode of the file browser. */
function changesView(projections: BrowserProjectionPort, api: FrontendApi, address: TabAddress, signal: AbortSignal) {
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const label = document.createElement('strong'); label.className = 'file-breadcrumbs'; label.textContent = 'Git changes';
  const refresh = iconButton('Refresh Git changes', 'refresh');
  toolbar.append(label, refresh);
  const body = document.createElement('div'); body.append(hint('Loading Git changes…'));
  root.append(toolbar, body);
  let loading: AbortController;
  async function load() {
    loading?.abort();
    loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    try {
      const changes = await api.request<GitChanges>(fileRoute(address, 'changes'), { signal: loadSignal });
      if (loadSignal.aborted) return;
      body.replaceChildren();
      if (!changes.available || !changes.files.length) body.append(hint(changes.reason ?? 'No Git changes.'));
      else for (const { path, status } of changes.files) body.append(fileEntry(api, address, path, path, status, 'diff'));
      if (changes.truncated) body.append(hint('Git status is truncated.'));
    } catch (error) {
      if (!loadSignal.aborted) body.replaceChildren(hint(error instanceof Error ? error.message : String(error)));
    }
  }
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

function diffView(projections: BrowserProjectionPort, api: FrontendApi, address: TabAddress, signal: AbortSignal) {
  if (!address.path) throw new Error('A diff requires a file path');
  const path = address.path;
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const crumbs = document.createElement('nav'); crumbs.className = 'file-breadcrumbs';
  const changes = control('Git changes', 'quiet');
  changes.onclick = () => api.contribute(layoutExtensions.openTab, 'changes', undefined, address);
  const label = document.createElement('span'); label.textContent = path; label.title = path;
  crumbs.append(changes, icon('chevron'), label);
  const refresh = iconButton('Refresh diff', 'refresh'); toolbar.append(crumbs, refresh);
  const body = document.createElement('div'); body.append(hint('Loading diff…')); root.append(toolbar, body);
  let loading: AbortController;
  async function load() {
    loading?.abort();
    loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    try {
      const { content, truncated } = await api.request<Preview>(fileRoute(address, 'diff', { path }), { signal: loadSignal });
      if (loadSignal.aborted) return;
      const pre = document.createElement('pre'); pre.className = 'diff';
      const lines = content.trimEnd().split('\n');
      for (const line of lines.slice(0, 5000)) {
        const span = document.createElement('span');
        span.className = line.startsWith('@@') ? 'diff-hunk' : /^(?:diff |index |--- |\+\+\+ )/.test(line) ? 'diff-header' :
          line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
        span.textContent = line + '\n'; pre.append(span);
      }
      if (lines.length > 5000) pre.append('… Diff shows the first 5,000 lines.');
      body.replaceChildren(pre);
      if (truncated) body.append(hint('Diff is truncated. Open the file locally to see the full change.'));
    } catch (error) {
      if (!loadSignal.aborted) body.replaceChildren(hint(error instanceof Error ? error.message : String(error)));
    }
  }
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

function fileView(projections: BrowserProjectionPort, api: FrontendApi, services: ConversationBrowserPort, address: TabAddress, signal: AbortSignal) {
  if (!address.path) throw new Error('A file preview requires a file path');
  const path = address.path;
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh file', 'refresh');
  const raw = control('Source', 'quiet'); raw.hidden = true;
  toolbar.append(breadcrumbs(api, services, address, path, true), raw, refresh);
  const body = document.createElement('div'); body.append(hint('Loading file…')); root.append(toolbar, body);
  let loading: AbortController;
  async function load() {
    loading?.abort();
    loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    try {
      const { content, image, video } = await api.request<Preview>(fileRoute(address, 'preview', { path }), { signal: loadSignal });
      if (loadSignal.aborted) return;
      raw.hidden = true;
      let view: HTMLElement;
      if (image) {
        const element = document.createElement('img');
        element.className = 'file-image'; element.alt = base(path);
        element.src = 'data:' + image + ';base64,' + content;
        view = element;
      } else if (video) {
        const element = document.createElement('video');
        element.className = 'file-image'; element.controls = true; element.preload = 'metadata';
        element.src = 'data:' + video + ';base64,' + content;
        view = element;
      } else view = textPreview(path, content, raw);
      body.replaceChildren(view);
    } catch (error) {
      if (!loadSignal.aborted) {
        raw.hidden = true;
        body.replaceChildren(hint(error instanceof Error ? error.message : String(error)));
      }
    }
  }
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

/** The composer inserts JSON-quoted workspace paths. Render only that syntax as a reference. */
function userReferences(text: string, open: (path: string) => void): Node {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of text.matchAll(/(^|\s)@("(?:[^"\\\r\n]|\\.)*")/g)) {
    let path: string;
    try { path = JSON.parse(match[2]); } catch { continue; }
    if (!path || /[\x00-\x1f]/.test(path)) continue;
    const start = match.index + match[1].length;
    fragment.append(text.slice(offset, start));
    const reference = document.createElement('button'); reference.type = 'button';
    reference.className = 'workspace-reference'; reference.title = path;
    reference.append(icon(path.endsWith('/') ? 'folder' : fileIcon(path)), document.createTextNode(path));
    reference.onclick = () => open(path);
    fragment.append(reference);
    offset = match.index + match[0].length;
  }
  fragment.append(text.slice(offset));
  return fragment;
}

const setup: FrontendSetup = (ctx, api) => {
  const services = ctx.harnessBrowser;
  const expanded = new WeakMap<TabAddress, Set<string>>();
  api.contribute(layoutExtensions.tab, 'files', {
    title: ({ path }) => path ? base(path) : 'Files',
    launcher: { title: 'Workspace files', description: 'Browse files in the current workspace', icon: 'folder' },
    create(address, signal) {
      let open = expanded.get(address);
      if (!open) { open = new Set<string>(); expanded.set(address, open); }
      return fileTree(ctx.miniProjections, api, services, address, signal, open);
    }
  });
  api.contribute(layoutExtensions.tab, 'file', {
    title: ({ path }) => path ? base(path) : 'File',
    create: (address, signal) => fileView(ctx.miniProjections, api, services, address, signal)
  });
  api.contribute(layoutExtensions.tab, 'changes', {
    title: () => 'Git changes',
    launcher: { title: 'Git changes', description: 'Inspect staged and working tree differences', icon: 'file-code' },
    create: (address, signal) => changesView(ctx.miniProjections, api, address, signal)
  });
  api.contribute(layoutExtensions.tab, 'diff', {
    title: ({ path }) => 'Diff: ' + base(path ?? ''),
    create: (address, signal) => diffView(ctx.miniProjections, api, address, signal)
  });
  api.contribute(conversationExtensions.userText, (text) => userReferences(text, (path) => {
    const scope = services.workspace();
    if (!scope) return;
    if (path.endsWith('/')) api.contribute(layoutExtensions.openTab, 'files', path.slice(0, -1) || undefined, scope);
    else api.contribute(layoutExtensions.openTab, 'file', path, scope);
  }));
  api.contribute(conversationExtensions.completion, '@', async ({ query, signal, show, replace }) => {
    const scope = services.workspace();
    if (!scope) return;
    if (query.startsWith('"')) return;
    const reference = (path: string) => replace('@' + JSON.stringify(path));
    if (query) {
      await wait(120, signal);
      if (signal.aborted) return;
      const paths = await api.request<string[]>(fileRoute(scope, 'search', { q: query }), { signal });
      show(paths.map((path) => ({ label: path, icon: 'file', run: () => reference(path) })), 'No matching files.');
      return;
    }
    const listing = new Map<string, Awaited<ReturnType<typeof readDirectory>>>();
    const open = new Set<string>();
    const loading = new Set<string>();
    const options = (path: string, depth = 0): Suggestion[] => (listing.get(path) ?? []).flatMap<Suggestion>((entry) => {
      if (!entry.directory) return [{ label: entry.name, icon: 'file', depth, run: () => reference(entry.path) }];
      const expanded = open.has(entry.path);
      const row: Suggestion = { label: entry.name, icon: expanded ? 'folder-open' : 'folder', expanded, depth, run: (complete) => {
        if (complete) { reference(entry.path + '/'); return; }
        if (loading.has(entry.path)) return;
        if (expanded) { open.delete(entry.path); draw(); }
        else void expand(entry.path).catch((error) => { if (!signal.aborted) services.report(error); });
      } };
      return expanded ? [row, {
        label: 'Reference ' + entry.name + '/', icon: 'folder', depth: depth + 1, run: () => reference(entry.path + '/')
      }, ...options(entry.path, depth + 1)] : [row];
    });
    const draw = () => show(options('.'), 'This directory is empty.');
    const expand = async (path: string) => {
      loading.add(path);
      try {
        if (!listing.has(path)) listing.set(path, await readDirectory(api, scope, path, signal));
        open.add(path);
        draw();
      } finally { loading.delete(path); }
    };
    await expand('.');
  });
};
export default setup;
