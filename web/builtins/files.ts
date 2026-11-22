import type { FrontendApi, FrontendServices, FrontendSetup, Suggestion } from '../extensions.js';
import type { TabAddress, TabScope } from '../right-tabs.js';
import { icon } from '../icons.js';
import { button as control, iconButton } from '../primitives.js';
import { workspaceRoute } from '../api.js';
import { renderMarkdown } from '../markdown.js';

interface FileEntry { name: string; directory: boolean }
interface FileChange { path: string; status: string }
interface GitChanges { available: boolean; files: FileChange[]; reason?: string }
interface Preview { content: string; image?: string }

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

const base = (path: string) => path.split('/').at(-1);
const extension = (path: string) => base(path).split('.').at(-1).toLowerCase();
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
  const name = services.bootstrap().workspaces.find(({ id }) => id === address.workspaceId)?.name ?? 'Workspace';
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
  const row = control('', 'quiet');
  row.classList.add('file-entry');
  row.title = path;
  row.onclick = () => api.openTab(diff ? 'diff' : 'preview', path, scope);
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

function fileTree(api: FrontendApi, services: FrontendServices, address: TabAddress, signal: AbortSignal) {
  const path = address.path ?? '.';
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh files', 'refresh');
  toolbar.append(breadcrumbs(api, services, address, path), refresh);
  const content = document.createElement('div');
  root.append(toolbar, content);
  const expanded = new Set<string>();
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
        summary.children[1].replaceWith(icon(details.open ? 'folder-open' : 'folder'));
        if (!details.open) { expanded.delete(entry.path); return; }
        expanded.add(entry.path);
        if (loaded || pending) return;
        pending = true;
        try {
          const branch = await tree(entry.path, loadSignal);
          if (!loadSignal.aborted) { details.append(branch); loaded = true; }
        } catch (error) { if (!loadSignal.aborted) details.append(hint(error.message)); }
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
    content.replaceChildren(hint('Loading files…'));
    try {
      const changes = await api.request<GitChanges>(fileRoute(address, 'changes'), { signal: loadSignal });
      loadSignal.throwIfAborted();
      groups.clear();
      for (const change of changes.files) groups.set(change.path, change.status);
      const listing = await tree(path, loadSignal);
      if (!loadSignal.aborted) content.replaceChildren(listing);
    } catch (error) { if (!loadSignal.aborted) content.replaceChildren(hint(error.message)); }
    finally { if (!loadSignal.aborted) content.removeAttribute('aria-busy'); }
  }
  refresh.onclick = () => void load();
  void load();
  return root;
}

function changesTab(api: FrontendApi, services: FrontendServices, address: TabAddress, signal: AbortSignal) {
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const refresh = iconButton('Refresh Git changes', 'refresh');
  toolbar.append(breadcrumbs(api, services, address, '.'), refresh);
  const body = document.createElement('div');
  root.append(toolbar, body);
  async function load() {
    refresh.disabled = true;
    body.replaceChildren(hint('Loading Git changes…'));
    try {
      const changes = await api.request<GitChanges>(fileRoute(address, 'changes'), { signal });
      const touched = address.sessionId ? services.session(address.sessionId)?.run?.changedFiles ?? [] : [];
      body.replaceChildren();
      const group = (title: string, nodes: HTMLElement[]) => {
        const heading = document.createElement('h3');
        heading.textContent = title;
        body.append(heading, ...nodes);
      };
      if (touched.length) group('Files written this turn', touched.map((path) => {
        const status = changes.files.find((item) => item.path === path)?.status;
        return fileEntry(api, address, path, path, status, Boolean(status));
      }));
      group('Git changes', changes.files.length
        ? changes.files.map(({ path, status }) => fileEntry(api, address, path, path, status, true))
        : [hint(changes.available ? 'Working tree is clean.' : changes.reason)]);
    } catch (error) { if (!signal.aborted) body.replaceChildren(hint(error.message)); }
    finally { refresh.disabled = false; }
  }
  refresh.onclick = () => void load();
  void load();
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
  if (lines.length > 5000) node.append('… Preview shows the first 5,000 lines.');
  return node;
}

function fileView(api: FrontendApi, services: FrontendServices, address: TabAddress, signal: AbortSignal, diff: boolean) {
  const { path } = address;
  const root = document.createElement('section');
  const toolbar = document.createElement('div');
  toolbar.className = 'file-toolbar';
  const alternate = control(diff ? 'Preview' : 'Diff', 'quiet');
  alternate.onclick = () => api.openTab(diff ? 'preview' : 'diff', path, address);
  toolbar.append(breadcrumbs(api, services, address, path, true), alternate);
  root.append(toolbar, hint('Loading file…'));
  function revealLine(line?: number) {
    if (!Number.isSafeInteger(line) || line < 1) return;
    const target = root.querySelector<HTMLElement>('[data-line="' + line + '"]');
    if (!target) return;
    const source = target.closest<HTMLElement>('.file-preview');
    if (source) source.hidden = false;
    const markdown = root.querySelector<HTMLElement>('.file-markdown');
    if (markdown) markdown.hidden = true;
    for (const previous of root.querySelectorAll('.highlighted-line')) previous.classList.remove('highlighted-line');
    target.classList.add('highlighted-line');
    target.scrollIntoView({ block: 'center' });
  }
  root.addEventListener('navigate-resource', (event: CustomEvent<TabAddress>) => { address.line = event.detail.line; revealLine(address.line); }, { signal });
  void api.request<Preview>(fileRoute(address, diff ? 'diff' : 'preview', { path }), { signal }).then(({ content, image }) => {
    if (signal.aborted) return;
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
      const raw = control('Source', 'quiet');
      raw.setAttribute('aria-pressed', 'false');
      const code = source(content, false);
      code.hidden = true;
      raw.onclick = () => {
        code.hidden = !code.hidden;
        markdown.hidden = !code.hidden;
        raw.setAttribute('aria-pressed', String(!code.hidden));
      };
      view = document.createElement('div');
      view.append(markdown, code);
      toolbar.append(raw);
    } else view = source(content, code.has(extension(path)));
    root.replaceChildren(toolbar, view);
    revealLine(address.line);
  }).catch((error) => { if (!signal.aborted) root.replaceChildren(toolbar, hint(error.message)); });
  return root;
}

const setup: FrontendSetup = (api, services) => {
  api.rightTab('files', {
    title: ({ path }) => path ? base(path) : 'Files',
    default: true,
    launcher: 'Browse files',
    create: (address, signal) => fileTree(api, services, address, signal)
  });
  api.rightTab('changes', {
    title: () => 'Git changes',
    launcher: 'Git changes',
    create: (address, signal) => changesTab(api, services, address, signal)
  });
  api.rightTab('preview', { canOpen: ({ path }) => Boolean(path), title: ({ path }) => base(path), create: (address, signal) => fileView(api, services, address, signal, false) });
  api.rightTab('diff', { canOpen: ({ path }) => Boolean(path), title: ({ path }) => 'Diff · ' + base(path), create: (address, signal) => fileView(api, services, address, signal, true) });
  const browse = iconButton('Workspace files', 'files', 'nav-action');
  const label = document.createElement('span');
  label.className = 'nav-label';
  label.textContent = 'Workspace files';
  browse.append(label);
  browse.onclick = () => api.openTab('files');
  api.mount('sidebar', browse);
  api.completion('@', async ({ query, signal, show, replace }) => {
    const scope = services.workspace();
    if (!scope) return;
    if (query.startsWith('"')) return;
    const reference = (path: string) => replace('@' + JSON.stringify(path));
    if (query) {
      await new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, 120);
        signal.addEventListener('abort', finish, { once: true });
      });
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
