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
import { renderMarkdown } from '@mini-harness/ui-primitives/markdown';

interface FileEntry { name: string; directory: boolean }
interface FileChange { path: string; status: string }
interface GitChanges { available: boolean; files: FileChange[]; truncated?: boolean; reason?: string }
interface Preview { content: string; image?: string; media?: string; truncated?: boolean }
interface Upload { name: string; mimeType: string; id: string }

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

function fileEntry(api: FrontendApi, scope: TabScope, path: string, label: string, status?: string, diff = false) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'file-entry';
  row.title = path;
  row.onclick = () => api.contribute(layoutExtensions.openTab, diff ? 'diff' : 'file', path, scope);
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

const tokens = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\/\/.*$|#.*$)|(\b(?:const|let|var|function|return|export|import|async|await|class|interface|def|fn|if|else|for|while|true|false|null|None|void|public|private)\b)|(\b\d+(?:\.\d+)?\b)/g;
function source(content: string, highlight: boolean) {
  const node = document.createElement('pre');
  node.className = 'file-preview';
  const lines = content.split('\n');
  for (const [index, text] of lines.slice(0, 5000).entries()) {
    const line = document.createElement('span');
    line.className = 'source-line';
    line.dataset.line = String(index + 1);
    let offset = 0;
    if (highlight && text.length <= 2048) {
      for (const match of text.matchAll(tokens)) {
        const token = document.createElement('span');
        token.className = match[1] ? 'syntax-string' : match[2] ? 'syntax-comment' : match[3] ? 'syntax-keyword' : 'syntax-number';
        token.textContent = match[0];
        line.append(text.slice(offset, match.index), token);
        offset = match.index + match[0].length;
      }
    }
    line.append(text.slice(offset));
    if (index < lines.length - 1) line.append('\n');
    node.append(line);
  }
  const truncated = '… Preview shows the first 5,000 lines.';
  if (lines.length > 5000) node.append(truncated);
  if (!highlight) return node;
  node.setAttribute('aria-hidden', 'true');
  const plain = document.createElement('pre');
  plain.className = 'file-accessible-source';
  plain.textContent = lines.length > 5000 ? lines.slice(0, 5000).join('\n') + '\n' + truncated : content;
  const wrapper = document.createElement('div');
  wrapper.append(node, plain);
  return wrapper;
}

function bytesOf(content: string) {
  return Uint8Array.from(atob(content), (char) => char.charCodeAt(0));
}

const inlineMedia = /^(?:image\/(?:png|jpeg|gif|webp)|video\/(?:mp4|webm|ogg|quicktime)|audio\/(?:mpeg|wav|ogg|mp4)|application\/pdf)$/;

function uploadPreview(file: Upload, data: string): Preview {
  if (inlineMedia.test(file.mimeType)) return { content: data, media: file.mimeType };
  const bytes = bytesOf(data);
  if (!bytes.includes(0)) {
    try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
    catch { /* Binary data is not interpreted as text. */ }
  }
  return { content: data, media: 'application/octet-stream' };
}

/** Text, Markdown and media use the same viewer for workspace and uploaded files. */
function previewBody(path: string, raw: HTMLButtonElement, body: HTMLElement, signal: AbortSignal) {
  let showSource = false;
  let objectUrl: string | undefined;
  const release = () => { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined; };
  signal.addEventListener('abort', release, { once: true });
  return ({ content, image, media, truncated }: Preview) => {
    release();
    raw.hidden = true;
    let view: HTMLElement;
    const mime = image ?? media;
    if (mime) {
      const bytes = bytesOf(content);
      const safeType = inlineMedia.test(mime) ? mime : 'application/octet-stream';
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: safeType }));
      const download = control('Download', 'quiet');
      download.onclick = () => {
        const link = document.createElement('a'); link.href = objectUrl!; link.download = base(path); link.click();
      };
      view = document.createElement('div');
      const label = hint(safeType === 'application/octet-stream' ? 'No inline preview for this file type.' : base(path));
      if (safeType.startsWith('image/')) {
        const element = document.createElement('img');
        element.className = 'file-image'; element.alt = base(path);
        element.src = 'data:' + safeType + ';base64,' + content;
        view.append(element);
      } else if (safeType.startsWith('video/') || safeType.startsWith('audio/')) {
        const element = document.createElement(safeType.startsWith('video/') ? 'video' : 'audio');
        element.className = 'file-media'; element.controls = true; element.preload = 'metadata'; element.src = objectUrl;
        element.setAttribute('aria-label', base(path));
        view.append(element);
      } else if (safeType === 'application/pdf') {
        const frame = document.createElement('iframe');
        frame.className = 'file-pdf'; frame.title = base(path); frame.src = objectUrl;
        view.append(frame);
      } else view.append(label);
      view.append(download);
    } else if (['md', 'markdown'].includes(extension(path))) {
      const markdown = document.createElement('div');
      markdown.className = 'markdown file-markdown'; renderMarkdown(markdown, content);
      const text = source(content, false);
      const displaySource = () => {
        text.hidden = !showSource; markdown.hidden = showSource;
        raw.setAttribute('aria-pressed', String(showSource));
      };
      raw.hidden = false;
      raw.onclick = () => { showSource = !showSource; displaySource(); };
      displaySource();
      view = document.createElement('div'); view.append(markdown, text);
    } else view = source(content, code.has(extension(path)));
    body.replaceChildren(view);
    if (truncated) body.append(hint('Preview is truncated.'));
  };
}

function fileView(projections: BrowserProjectionPort, api: FrontendApi, services: ConversationBrowserPort, address: TabAddress, signal: AbortSignal) {
  if (!address.path) throw new Error('A file preview requires a file path');
  const path = address.path;
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh file', 'refresh');
  const raw = control('Source', 'quiet'); raw.hidden = true;
  toolbar.append(breadcrumbs(api, services, address, path, true), raw, refresh);
  const body = document.createElement('div'); body.append(hint('Loading file…'));
  root.append(toolbar, body);
  const render = previewBody(path, raw, body, signal);
  let loading: AbortController | undefined;
  async function load() {
    loading?.abort(); loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    try {
      const result = await api.request<Preview>(fileRoute(address, 'preview', { path }), { signal: loadSignal });
      if (!loadSignal.aborted) render(result);
    } catch (error) {
      if (!loadSignal.aborted) { raw.hidden = true; body.replaceChildren(hint(error instanceof Error ? error.message : String(error))); }
    }
  }
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

function attachmentView(api: FrontendApi, address: TabAddress, signal: AbortSignal) {
  const file: Upload = JSON.parse(address.path!);
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const label = document.createElement('span'); label.className = 'file-breadcrumbs'; label.textContent = file.name;
  const raw = control('Source', 'quiet'); raw.hidden = true;
  const download = control('Download', 'quiet'); download.hidden = true;
  toolbar.append(label, raw, download);
  const body = document.createElement('div'); body.append(hint('Loading attachment…')); root.append(toolbar, body);
  const render = previewBody(file.name, raw, body, signal);
  void api.request<{ data: string }>('/sessions/' + address.sessionId + '/attachments/' + file.id, { signal }).then(({ data }) => {
    if (signal.aborted) return;
    render(uploadPreview(file, data));
    const url = URL.createObjectURL(new Blob([bytesOf(data)], { type: 'application/octet-stream' }));
    signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
    download.hidden = false;
    download.onclick = () => { const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); };
  }).catch((error) => { if (!signal.aborted) body.replaceChildren(hint(error.message)); });
  return root;
}

function changesView(projections: BrowserProjectionPort, api: FrontendApi, address: TabAddress, signal: AbortSignal) {
  const root = document.createElement('section');
  const toolbar = document.createElement('div'); toolbar.className = 'file-toolbar';
  const title = document.createElement('span'); title.className = 'file-breadcrumbs'; title.textContent = 'Git changes';
  const refresh = iconButton('Refresh changes', 'refresh'); toolbar.append(title, refresh);
  const body = document.createElement('div'); body.append(hint('Loading changes…')); root.append(toolbar, body);
  let loading: AbortController | undefined;
  async function load() {
    loading?.abort(); loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    try {
      const result = await api.request<GitChanges>(fileRoute(address, 'changes'), { signal: loadSignal });
      if (loadSignal.aborted) return;
      body.replaceChildren(...result.files.map(({ path, status }) => fileEntry(api, address, path, path, status, true)));
      if (!result.files.length) body.append(hint(result.reason ?? 'No Git changes.'));
      if (result.truncated) body.append(hint('Git status is truncated.'));
    } catch (error) { if (!loadSignal.aborted) body.replaceChildren(hint(error instanceof Error ? error.message : String(error))); }
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
  const back = control('Git changes', 'quiet'); back.onclick = () => api.contribute(layoutExtensions.openTab, 'changes', undefined, address);
  const title = document.createElement('span'); title.className = 'file-breadcrumbs'; title.textContent = path;
  const refresh = iconButton('Refresh diff', 'refresh'); toolbar.append(back, title, refresh);
  const body = document.createElement('div'); body.append(hint('Loading diff…')); root.append(toolbar, body);
  let loading: AbortController | undefined;
  async function load() {
    loading?.abort(); loading = new AbortController();
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
    } catch (error) { if (!loadSignal.aborted) body.replaceChildren(hint(error instanceof Error ? error.message : String(error))); }
  }
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

const setup: FrontendSetup = (ctx, api) => {
  const services = ctx.harnessBrowser;
  const expanded = new WeakMap<TabAddress, Set<string>>();
  api.contribute(layoutExtensions.tab, 'files', {
    title: ({ path }) => path ? base(path) : 'Files',
    launcher: { title: 'Workspace files', description: 'Browse and preview files in this workspace', icon: 'folder' },
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
    launcher: { title: 'Git changes', description: 'Review staged and working tree changes', icon: 'file-code' },
    create: (address, signal) => changesView(ctx.miniProjections, api, address, signal)
  });
  api.contribute(layoutExtensions.tab, 'diff', {
    title: ({ path }) => 'Diff: ' + base(path ?? ''),
    create: (address, signal) => diffView(ctx.miniProjections, api, address, signal)
  });
  api.contribute(layoutExtensions.tab, 'attachment', {
    title: ({ path }) => (JSON.parse(path!) as Upload).name, sessionScoped: true,
    create: (address, signal) => attachmentView(api, address, signal)
  });
  api.contribute(conversationExtensions.reference, (path) => {
    const scope = services.workspace();
    if (!scope) return;
    const directory = path.endsWith('/');
    api.contribute(layoutExtensions.openTab, directory ? 'files' : 'file', directory ? path.slice(0, -1) || '.' : path, scope);
  });
  api.contribute(conversationExtensions.attachmentPreview, (file, sessionId) => {
    const scope = services.workspace();
    if (!scope || !file.id || scope.sessionId !== sessionId) return;
    api.contribute(layoutExtensions.openTab, 'attachment', JSON.stringify({ name: file.name, mimeType: file.mimeType, id: file.id }), scope);
  });
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
