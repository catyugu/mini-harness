import type { FrontendApi } from './extensions.js';
import { icon } from './icons.js';
import { data } from './api.js';

interface FileEntry { name: string; directory: boolean }
export async function readDirectory(path: string) {
  const entries = await data<FileEntry[]>('/files/tree?path=' + encodeURIComponent(path));
  return entries.sort((a, b) => Number(b.directory) - Number(a.directory)).map(({ name, directory }) => ({
    name, directory, path: path === '.' ? name : path + '/' + name
  }));
}

export function fileLabel(node: HTMLElement, name: string, kind: 'file' | 'folder' | 'folder-open') {
  const label = document.createElement('span');
  label.textContent = name;
  node.append(icon(kind), label);
}

export function fileInspector(api: FrontendApi, changed: () => string[]) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'small-button'; button.append(icon('files'), document.createTextNode(' Workspace files'));
  const root = document.createElement('section');
  let disposed = false, request = 0;
  api.onDispose(() => { disposed = true; });
  const fail = (error: Error) => { if (!disposed) { const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = error.message; root.append(hint); } };
  const showFile = async (path: string, diff = false) => {
    const current = ++request;
    try {
      const result = await api.request<{ content: string }>('/files/' + (diff ? 'diff' : 'preview') + '?path=' + encodeURIComponent(path));
      if (disposed || current !== request) return;
      const container = document.createElement('div'), back = document.createElement('button'), pre = document.createElement('pre');
      back.type = 'button'; back.className = 'link-button'; back.textContent = 'Back to files'; back.onclick = () => void show();
      pre.className = diff ? 'diff' : 'file-preview';
      if (diff) {
        for (const line of result.content.split('\n')) { const span = document.createElement('span'); span.className = line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : ''; span.textContent = line + '\n'; pre.append(span); }
      } else pre.textContent = result.content;
      container.append(back, pre); api.inspect(path, container);
    } catch (error) {
      if (current === request && !disposed) { api.inspect(path, root); fail(error); }
    }
  };
  const entryButton = (path: string, label: string, diff = false) => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'file-entry'; fileLabel(button, label, 'file'); button.title = path; button.onclick = () => void showFile(path, diff); return button;
  };
  const tree = async (path = '.') => {
    const list = document.createElement('div'); list.className = 'file-tree';
    for (const entry of await readDirectory(path)) {
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
