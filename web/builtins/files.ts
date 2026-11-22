import type { FrontendApi, FrontendSetup, Suggestion } from '../extensions.js';
import { icon, fileLabel } from '../icons.js';

interface FileEntry { name: string; directory: boolean }
async function readDirectory(api: FrontendApi, path: string, signal?: AbortSignal) {
  const entries = await api.request<FileEntry[]>('/files/tree?path=' + encodeURIComponent(path), { signal });
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory)).map(({ name, directory }) => ({
    name, directory, path: path === '.' ? name : path + '/' + name
  }));
}

function fileInspector(api: FrontendApi, changed: () => string[]) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'nav-action'; button.setAttribute('aria-label', 'Workspace files');
  const label = document.createElement('span'); label.className = 'nav-label'; label.textContent = 'Workspace files';
  button.append(icon('files'), label);
  const root = document.createElement('section');
  let disposed = false, request = 0;
  api.onDispose(() => { disposed = true; });
  const fail = (error: Error) => { if (!disposed) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = error.message; root.append(hint); } };
  const showFile = (path: string, canDiff: boolean) => {
    const container = document.createElement('div'), toolbar = document.createElement('div');
    const content = document.createElement('div'), back = document.createElement('button');
    const modes = new Map<boolean, HTMLButtonElement>();
    toolbar.className = 'file-view-actions';
    back.type = 'button';
    back.className = 'link-button';
    back.textContent = 'Back to files';
    back.onclick = () => void show();
    toolbar.append(back);
    if (canDiff) for (const diff of [false, true]) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'link-button';
      toggle.textContent = diff ? 'Diff' : 'Preview';
      toggle.onclick = () => void load(diff);
      modes.set(diff, toggle);
      toolbar.append(toggle);
    }
    container.append(toolbar, content);
    api.inspect(path, container);
    async function load(diff: boolean) {
      const current = ++request;
      const pre = document.createElement('pre');
      pre.className = diff ? 'diff' : 'file-preview';
      content.setAttribute('aria-busy', 'true');
      content.replaceChildren(pre);
      for (const [mode, button] of modes) button.setAttribute('aria-pressed', String(mode === diff));
      try {
        const result = await api.request<{ content: string }>('/files/' + (diff ? 'diff' : 'preview') + '?path=' + encodeURIComponent(path));
        if (disposed || current !== request) return;
        if (diff) {
          const fragment = document.createDocumentFragment();
          for (const line of result.content.trimEnd().split('\n')) {
            const span = document.createElement('span');
            span.className = line.startsWith('@@') ? 'diff-hunk' :
              /^(?:diff |index |--- |\+\+\+ )/.test(line) ? 'diff-header' :
                line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : '';
            span.textContent = line + '\n';
            fragment.append(span);
          }
          pre.append(fragment);
        } else pre.textContent = result.content;
      } catch (error) {
        if (current === request && !disposed) {
          const warning = document.createElement('p');
          warning.className = 'hint';
          warning.setAttribute('role', 'status');
          warning.textContent = error.message;
          content.replaceChildren(warning);
        }
      } finally {
        if (current === request) content.removeAttribute('aria-busy');
      }
    }
    void load(canDiff);
  };
  const entryButton = (path: string, label: string, diff = false) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'file-entry'; fileLabel(button, label, 'file'); button.title = path; button.onclick = () => showFile(path, diff); return button;
  };
  const tree = async (path = '.') => {
    const list = document.createElement('div'); list.className = 'file-tree';
    for (const entry of await readDirectory(api, path)) {
      if (entry.directory) {
        const details = document.createElement('details'), summary = document.createElement('summary');
        const label = document.createElement('span');
        label.textContent = entry.name;
        summary.append(icon('chevron'), icon('folder'), label);
        summary.title = entry.path;
        details.append(summary);
        let loading = false, loaded = false;
        details.ontoggle = async () => {
          summary.children[1].replaceWith(icon(details.open ? 'folder-open' : 'folder'));
          if (!details.open || loaded || loading) return;
          loading = true;
          try { details.append(await tree(entry.path)); loaded = true; }
          catch (error) { fail(error); }
          finally { loading = false; }
        };
        list.append(details);
      } else list.append(entryButton(entry.path, entry.name));
    }
    return list;
  };
  const show = async () => {
    const current = ++request;
    root.replaceChildren(); api.inspect('Workspace', root);
    const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'small-button'; refresh.textContent = 'Refresh files'; refresh.onclick = () => void show(); root.append(refresh);
    try {
      const changes = await api.request<{ available: boolean; files: { path: string; status: string }[]; reason?: string }>('/files/changes');
      if (disposed || current !== request) return;
      const heading = (text: string) => { const h = document.createElement('h3'); h.textContent = text; root.append(h); };
      heading('Files written this turn');
      const touched = changed();
      if (!touched.length) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'No file edits recorded for this turn.'; root.append(hint); }
      for (const path of touched) root.append(entryButton(path, path, changes.files.some((f) => f.path === path)));
      heading('Git changes');
      if (!changes.files.length) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = changes.available ? 'Working tree is clean.' : changes.reason; root.append(hint); }
      for (const file of changes.files) root.append(entryButton(file.path, file.status + ' ' + file.path, true));
      heading('Files');
      const content = await tree();
      if (!disposed && current === request) root.append(content);
    } catch (error) { if (current === request) fail(error); }
  };
  button.onclick = () => void show(); api.mount('sidebar', button);
  const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'link-button'; tab.textContent = 'Files'; tab.onclick = () => void show(); api.mount('inspector', tab);
  api.onDispose(() => root.remove());
}

const setup: FrontendSetup = (api, services) => {
  fileInspector(api, services.changedFiles);
  api.completion('@', async ({ query, signal, show, replace }) => {
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
      const paths = await api.request<string[]>('/files/search?q=' + encodeURIComponent(query), { signal });
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
        if (!listing.has(path)) listing.set(path, await readDirectory(api, path, signal));
        open.add(path);
        draw();
      } finally { loading.delete(path); }
    };
    await expand('.');
  });
};
export default setup;
