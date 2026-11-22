import type { BrowserPlugin, FrontendApi } from './extensions.js';
import { closeOnBackdrop, fromMarkup } from './primitives.js';
import { scopedElements, payload } from './api.js';
import { fileLabel, icon } from './icons.js';
export const workspacePlugin: BrowserPlugin = {
  id: 'core:workspace', inject: ['miniState'],
  setup(ctx, api) { ctx.provide('miniWorkspace', workspacePicker(api, ctx.miniState.get().workspace)); }
};

declare module 'cordis' {
  interface Context { miniWorkspace: ReturnType<typeof workspacePicker> }
}

function workspacePicker(api: FrontendApi, path: string) {
  const button = fromMarkup<HTMLButtonElement>(`
    <button id="workspaceOpen" class="workspace-button" type="button" aria-label="Choose workspace"><span data-icon="folder"></span><small id="workspaceLabel"></small><span class="workspace-chevron" data-icon="chevron"></span></button>`);
  const label = button.querySelector('small');
  label.textContent = path;
  label.title = path;
  const dialog = fromMarkup<HTMLDialogElement>(`
  <dialog id="workspacePanel" class="workspace-panel" aria-labelledby="workspaceTitle">
    <header class="settings-header"><h2 id="workspaceTitle">Workspace</h2><button id="workspaceClose" type="button" class="icon-button" aria-label="Close workspace picker" data-icon="close"></button></header>
    <form id="workspaceForm" class="settings-scroll"><p class="hint">Switch the local server to a directory. Stop running tasks first. Other tabs will need to reload.</p>
      <div id="workspaceList"></div><label for="workspacePath">Absolute directory path</label><input id="workspacePath" required>
      <p id="workspaceStatus" class="hint" role="status"></p><button id="switchWorkspace" class="primary" type="submit">Open workspace</button>
    </form>
  </dialog>`);
  api.mount('dialogs', dialog);
  const { element } = scopedElements(dialog);
  closeOnBackdrop(dialog);
  const status = element('workspaceStatus');
  const sidebar = fromMarkup(`<section class="workspace-nav" aria-label="Recent workspaces">
    <header><span>Workspaces</span><button type="button" class="icon-button" aria-label="Open workspace directory"></button></header>
    <div class="workspace-shortcuts"></div>
  </section>`);
  const directory = sidebar.querySelector('button');
  directory.append(icon('plus'));
  directory.onclick = () => void open();
  api.mount('sidebar', sidebar, 20);
  const shortcuts = sidebar.querySelector('.workspace-shortcuts');
  function renderShortcuts(paths: string[]) {
    shortcuts.replaceChildren(...paths.slice(0, 5).map((item) => {
      const shortcut = document.createElement('button');
      shortcut.type = 'button';
      shortcut.className = 'workspace-shortcut';
      shortcut.title = item;
      if (item === path) shortcut.setAttribute('aria-current', 'location');
      fileLabel(shortcut, item.split(/[/\\]/).filter(Boolean).at(-1) || item, 'folder');
      shortcut.onclick = () => void open(item);
      return shortcut;
    }));
  }
  renderShortcuts([path]);
  const recent = api.request<{ current: string; paths: string[] }>('/workspaces');
  void recent.then((result) => renderShortcuts(result.paths)).catch(() => {});
  async function open(preselected?: string) {
    try {
      const result = await api.request<{ current: string; paths: string[] }>('/workspaces');
      element<'input'>('workspacePath').value = preselected ?? result.current; status.textContent = '';
      element('workspaceList').replaceChildren(...result.paths.map((path) => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'file-entry'; fileLabel(button, path, 'folder'); button.title = path;
        button.onclick = () => { element<'input'>('workspacePath').value = path; }; return button;
      }));
      dialog.showModal();
    } catch (error) { status.textContent = error.message; dialog.showModal(); }
  }
  button.onclick = () => void open();
  element('workspaceClose').onclick = () => dialog.close();
  element<'form'>('workspaceForm').onsubmit = async (event) => {
    event.preventDefault(); const button = element<'button'>('switchWorkspace'); button.disabled = true;
    try { await api.request('/workspaces', payload('POST', { path: element<'input'>('workspacePath').value.trim() })); location.reload(); }
    catch (error) { status.textContent = error.message; button.disabled = false; }
  };
  api.onDispose(() => button.remove());
  return button;
}
