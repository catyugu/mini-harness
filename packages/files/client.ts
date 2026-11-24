import type { FrontendApi, FrontendServices, FrontendSetup, Suggestion } from '@mini-harness/ui-runtime/frontend';
import type { BrowserProjectionPort } from '@mini-harness/contracts/browser';
import type { TabAddress, TabScope } from '@mini-harness/contracts/layout';
import { icon } from '@mini-harness/ui-primitives/icons';
import { button as control, iconButton } from '@mini-harness/ui-primitives/primitives';
import { workspaceRoute } from '@mini-harness/contracts/workspace';
import { wait } from '@mini-harness/ui-runtime/http';
import { renderMarkdown } from '@mini-harness/ui-primitives/markdown';

interface FileEntry { name: string; directory: boolean }
interface FileChange { path: string; status: string }
interface GitChanges { available: boolean; files: FileChange[]; truncated?: boolean; reason?: string }
interface Preview { content: string; image?: string; truncated?: boolean }

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

function breadcrumbs(api: FrontendApi, services: FrontendServices, address: TabAddress, path: string, leaf = false) {
  const node = document.createElement('nav');
  node.className = 'file-breadcrumbs';
  node.setAttribute('aria-label', 'File path');
  const name = services.workspaceRecord(address.workspaceId)?.name ?? 'Workspace';
  const crumbs = path === '.' ? [] : path.split('/');
  const root = control(name, 'quiet');
  const open = (path?: string) => api.openTab('files', path, address);
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
  row.onclick = () => api.openTab('file', path, scope, diff ? 'diff' : 'preview');
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

function fileTree(projections: BrowserProjectionPort, api: FrontendApi, services: FrontendServices, address: TabAddress, signal: AbortSignal, expanded: Set<string>) {
  const path = address.path ?? '.';
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh files', 'refresh');
  toolbar.append(breadcrumbs(api, services, address, path), refresh);
  const content = document.createElement('div');
  root.append(toolbar, content);
  let loading: AbortController;
  const groups = new Map<string, string>();
  async function tree(path: string, loadSignal: AbortSignal) {
    const list = document.createElement('div');
    list.className = 'file-tree';
    for (const entry of await readDirectory(api, address, path, loadSignal)) {
      if (!entry.directory) {
        list.append(fileEntry(api, address, entry.path, entry.name, groups.get(entry.path)));
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
      const changes = await api.request<GitChanges>(fileRoute(address, 'changes'), { signal: loadSignal });
      loadSignal.throwIfAborted();
      groups.clear();
      for (const change of changes.files) groups.set(change.path, change.status);
      const listing = await tree(path, loadSignal);
      if (!loadSignal.aborted) {
        content.replaceChildren(listing);
        if (changes.truncated) content.append(hint('Git status is truncated.'));
      }
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

function fileView(projections: BrowserProjectionPort, api: FrontendApi, services: FrontendServices, address: TabAddress, signal: AbortSignal) {
  if (!address.path) throw new Error('A file preview requires a file path');
  const path = address.path;
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const alternate = control('', 'quiet');
  const refresh = iconButton('Refresh file', 'refresh');
  const raw = control('Source', 'quiet');
  raw.hidden = true;
  toolbar.append(breadcrumbs(api, services, address, path, true), alternate, raw, refresh);
  const body = document.createElement('div');
  body.append(hint('Loading file…'));
  root.append(toolbar, body);
  let loading: AbortController | undefined;
  let showSource = false;
  async function load() {
    loading?.abort();
    loading = new AbortController();
    const loadSignal = AbortSignal.any([signal, loading.signal]);
    const diff = address.mode === 'diff';
    alternate.textContent = diff ? 'Preview' : 'Diff';
    try {
      const { content, image, truncated } = await api.request<Preview>(fileRoute(address, diff ? 'diff' : 'preview', { path }), { signal: loadSignal });
      if (loadSignal.aborted) return;
      raw.hidden = true;
      let view: HTMLElement;
      if (image && !diff) {
        const element = document.createElement('img');
        element.className = 'file-image';
        element.alt = base(path);
        element.src = 'data:' + image + ';base64,' + content;
        view = element;
      } else if (diff) {
        const pre = document.createElement('pre');
        pre.className = 'diff';
        const lines = (image ? 'Binary image' : content).trimEnd().split('\n');
        for (const line of lines.slice(0, 5000)) {
          const span = document.createElement('span');
          span.className = line.startsWith('@@') ? 'diff-hunk' : /^(?:diff |index |--- |\+\+\+ )/.test(line) ? 'diff-header' :
            line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
          span.textContent = line + '\n';
          pre.append(span);
        }
        if (lines.length > 5000) pre.append('… Diff shows the first 5,000 lines.');
        view = pre;
      } else if (['md', 'markdown'].includes(extension(path))) {
        const markdown = document.createElement('div');
        markdown.className = 'markdown file-markdown';
        renderMarkdown(markdown, content);
        const code = source(content, false);
        const displaySource = () => {
          code.hidden = !showSource;
          markdown.hidden = showSource;
          raw.setAttribute('aria-pressed', String(showSource));
        };
        raw.hidden = false;
        raw.onclick = () => { showSource = !showSource; displaySource(); };
        displaySource();
        view = document.createElement('div');
        view.append(markdown, code);
      } else view = source(content, code.has(extension(path)));
      body.replaceChildren(view);
      if (truncated) body.append(hint('Diff is truncated. Open the file locally to see the full change.'));
    } catch (error) {
      if (!loadSignal.aborted) {
        raw.hidden = true;
        body.replaceChildren(hint(error instanceof Error ? error.message : String(error)));
      }
    }
  }
  alternate.onclick = () => {
    address.mode = address.mode === 'diff' ? 'preview' : 'diff';
    void load();
  };
  refresh.onclick = () => void load();
  refreshFiles(projections, address, root, signal, load);
  return root;
}

const setup: FrontendSetup = (ctx, api) => {
  const services = ctx.harnessBrowser;
  const expanded = new WeakMap<TabAddress, Set<string>>();
  api.rightTab('files', {
    title: ({ path }) => path ? base(path) : 'Files',
    default: true,
    create(address, signal) {
      let open = expanded.get(address);
      if (!open) { open = new Set<string>(); expanded.set(address, open); }
      return fileTree(ctx.miniProjections, api, services, address, signal, open);
    }
  });
  api.rightTab('file', {
    title: ({ path }) => path ? base(path) : 'File',
    create: (address, signal) => fileView(ctx.miniProjections, api, services, address, signal)
  });
  api.completion('@', async ({ query, signal, show, replace }) => {
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
