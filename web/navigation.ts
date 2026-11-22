import type { Conversation } from '../src/registry.js';
import type { WorkspaceRecord } from '../src/workspace-catalog.js';
import type { NavigationEvent } from '../src/transport/navigation-events.js';
import { exportSessions } from './transport/session-client.js';
import type { BrowserState } from './models/browser-state.js';
import type { FrontendApi } from './kernel/extensions.js';
import { api as request, readEvents, scopedElements, payload, wait } from './api.js';
import { workspaceTree } from './navigation-tree.js';
import { sessionTree } from './sessions.js';
import { button, dialog, field, fromMarkup, iconButton } from './primitives.js';
import { fileLabel, icon } from './icons.js';

interface NavigationServices {
  state: BrowserState;
  activate(id: string): void;
  select(id: string, draft?: boolean): void;
  chooseWorkspace(onAdd: (record: WorkspaceRecord) => void): void;
  renameWorkspace(record: WorkspaceRecord): void;
  removeWorkspace(record: WorkspaceRecord): Promise<void>;
  clearConversation(): void;
  report(error: Error): void;
  setTitle(title: string): void;
}

export function sessionNavigation(api: FrontendApi, options: NavigationServices) {
  const { state } = options;
  const panel = fromMarkup(`<div class="session-navigation">
    <div class="sidebar-caption">
      <span>Workspaces</span>
      <div id="workspaceActions"><button id="selectMode" class="link-button" type="button" aria-pressed="false">Select</button></div>
    </div>
    <input id="sessionSearch" class="ui-input" type="search" placeholder="Search workspaces and chats" aria-label="Search workspaces and conversations">
    <nav id="sessions" class="sessions" aria-label="Conversation tree"></nav>
    <div id="bulkActions" class="bulk-actions" hidden>
      <span id="selectedCount" aria-live="polite"></span>
    </div>
  </div>`);
  api.mount('session-navigation', panel);
  const { element, value } = scopedElements(panel);
  const title = document.createElement('input');
  title.required = true;
  title.maxLength = 140;
  const renameForm = document.createElement('form');
  renameForm.className = 'workspace-form';
  const status = document.createElement('p');
  status.className = 'form-error';
  status.setAttribute('role', 'status');
  const save = button('Rename', 'primary');
  save.type = 'submit';
  renameForm.append(field('Title', title), status, save);
  const renameDialog = dialog('Rename conversation', renameForm);
  api.mount('dialogs', renameDialog);
  let renaming: string;
  const selection = new Set<string>(), expanded = new Set<string>();
  const storageKey = 'mini-harness-collapsed-workspaces';
  const collapsed = new Set<string>(JSON.parse(localStorage.getItem(storageKey) ?? '[]'));

  const menu = document.createElement('div');
  menu.className = 'workspace-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Workspace actions');
  menu.hidden = true;
  const renameAction = button('Rename', 'quiet');
  renameAction.setAttribute('role', 'menuitem');
  renameAction.prepend(icon('edit'));
  const removeAction = button('Delete workspace', 'quiet');
  removeAction.setAttribute('role', 'menuitem');
  removeAction.dataset.danger = 'true';
  removeAction.prepend(icon('trash'));
  menu.append(renameAction, removeAction);
  api.mount('dialogs', menu);
  let menuTrigger: HTMLElement | undefined;

  function closeMenu(restoreFocus = false) {
    if (menu.hidden) return;
    menu.hidden = true;
    menuTrigger?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menuTrigger?.isConnected) menuTrigger.focus({ preventScroll: true });
    menuTrigger = undefined;
  }
  function openMenu(record: WorkspaceRecord, trigger: HTMLElement) {
    closeMenu();
    menuTrigger = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    renameAction.onclick = () => { closeMenu(); options.renameWorkspace(record); };
    removeAction.onclick = () => {
      closeMenu();
      void options.removeWorkspace(record).catch(options.report);
    };
    menu.hidden = false;
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)) + 'px';
    const below = anchor.bottom + 4;
    menu.style.top = (below + bounds.height > innerHeight - 8
      ? Math.max(8, anchor.top - bounds.height - 4) : below) + 'px';
    renameAction.focus({ preventScroll: true });
  }
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target) && !menuTrigger?.contains(event.target))
      closeMenu();
  }, { signal: api.signal });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(true); }
  }, { signal: api.signal });
  window.addEventListener('resize', () => closeMenu(), { signal: api.signal });
  element('sessions').addEventListener('scroll', () => closeMenu(), { signal: api.signal });

  let draggingWorkspace: string | undefined;
  function clearDrag() {
    for (const row of element('sessions').querySelectorAll<HTMLElement>('.workspace-row')) {
      row.classList.remove('workspace-dragging');
      delete row.dataset.dropSide;
    }
    draggingWorkspace = undefined;
  }

  let selecting = false;
  let visible: Conversation[] = [];
  const selectAll = button('Select all');
  const exportButton = button('Export');
  const deleteButton = button('Delete', 'danger');
  const cancel = button('Cancel', 'quiet');
  element('bulkActions').append(selectAll, exportButton, deleteButton, cancel);
  const addWorkspace = iconButton('Add workspace', 'plus');
  element('workspaceActions').append(addWorkspace);
  addWorkspace.onclick = () => options.chooseWorkspace((record) => {
    if (!state.get().workspaces.some(({ id }) => id === record.id)) state.get().workspaces.push(record);
    revealWorkspace(record.id);
    options.select(record.id);
  });

  async function remove(ids: string[]) {
    const result = await api.request<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids }));
    for (const id of result.deleted) state.applyNavigation({ type: 'delete', id });
  }

  function rename(item: Conversation) {
    renaming = item.id;
    title.value = item.title;
    status.textContent = '';
    renameDialog.showModal();
    title.select();
  }
  renameForm.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    save.disabled = true;
    try {
      await api.request('/sessions/' + renaming, payload('PATCH', { title: title.value }));
      renameDialog.close();
    } catch (error) { status.textContent = error.message; }
    finally { save.disabled = false; }
  };

  function selectionChanged() {
    element('selectMode').setAttribute('aria-pressed', String(selecting));
    element('bulkActions').hidden = !selecting;
    element('selectedCount').textContent = selection.size + ' selected';
    exportButton.disabled = deleteButton.disabled = !selection.size;
    selectAll.disabled = !visible.length;
  }

  function toggleSelection(value: boolean) {
    selecting = value;
    selection.clear();
    render();
  }

  const rememberCollapsed = () => localStorage.setItem(storageKey, JSON.stringify([...collapsed]));
  function revealWorkspace(id: string) {
    const parents = workspaceTree(state.get().workspaces).parents;
    for (let cursor = id; cursor; cursor = parents.get(cursor)) collapsed.delete(cursor);
    rememberCollapsed();
  }

  function render() {
    const { sessions, workspaces } = state.get();
    const query = value('sessionSearch').toLowerCase();
    const container = element('sessions');
    const focus = container.contains(document.activeElement) ? document.activeElement.id : '';
    const scroll = container.scrollTop;
    const { children, grouped, labels, parents } = workspaceTree(workspaces, sessions);
    visible = [];
    closeMenu();
    clearDrag();

    async function reorderWorkspace(sourceId: string, targetId: string, side: 'before' | 'after') {
      if (sourceId === targetId || parents.get(sourceId) !== parents.get(targetId)) return;
      const siblings = (children.get(parents.get(sourceId)) ?? []).map(({ id }) => id);
      if (!siblings.includes(sourceId) || !siblings.includes(targetId)) return;
      const moved = siblings.filter((id) => id !== sourceId);
      moved.splice(moved.indexOf(targetId) + (side === 'after' ? 1 : 0), 0, sourceId);
      if (moved.every((id, index) => id === siblings[index])) return;
      const siblingSet = new Set(siblings);
      let next = 0;
      const ids = workspaces.map(({ id }) => siblingSet.has(id) ? moved[next++] : id);
      try {
        const saved = await api.request<WorkspaceRecord[]>('/workspaces', payload('PUT', { ids }));
        state.applyNavigation({ type: 'workspaces', workspaces: saved });
      } catch (error) { options.report(error); }
    }
    function workspaceBranch(parent?: string) {
      const list = document.createElement('ul');
      list.className = 'workspace-branch';
      for (const record of children.get(parent) ?? []) {
        const { id, name, path } = record;
        const matches = !query || name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
        const current = state.selectedWorkspace === id;
        const tree = sessionTree(grouped.get(id) ?? [], {
          active: state.activeConversation, expanded, selection, selecting, query: matches ? '' : query,
          render, selectionChanged, activate: options.activate, rename,
          remove(item) {
            if (confirm('Permanently delete "' + item.title + '" and all child conversations?'))
              void remove([item.id]).catch(options.report);
          }
        });
        const branches = workspaceBranch(id);
        if (!matches && !tree.visible.length && !branches.childElementCount) continue;
        visible.push(...tree.visible);
        const open = !collapsed.has(id) || Boolean(query);
        const row = document.createElement('div');
        row.className = 'workspace-row';
        row.dataset.workspaceId = id;
        row.draggable = !selecting && !query;
        row.ondragstart = (event) => {
          if (!row.draggable || event.target instanceof Element && event.target.closest('.workspace-actions, .tree-button')) {
            event.preventDefault();
            return;
          }
          closeMenu();
          draggingWorkspace = id;
          row.classList.add('workspace-dragging');
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', id);
        };
        row.ondragover = (event) => {
          if (!draggingWorkspace || draggingWorkspace === id || parents.get(draggingWorkspace) !== parents.get(id)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const bounds = row.getBoundingClientRect();
          row.dataset.dropSide = event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after';
        };
        row.ondragleave = (event) => {
          if (!(event.relatedTarget instanceof Node) || !row.contains(event.relatedTarget))
            delete row.dataset.dropSide;
        };
        row.ondrop = (event) => {
          const source = draggingWorkspace;
          const side = row.dataset.dropSide as 'before' | 'after' | undefined;
          if (!source || !side) return;
          event.preventDefault();
          clearDrag();
          void reorderWorkspace(source, id, side);
        };
        row.ondragend = clearDrag;
        const toggle = iconButton((open ? 'Collapse workspace ' : 'Expand workspace ') + name, 'triangle', 'tree-button');
        toggle.id = 'workspace-toggle-' + id;
        toggle.setAttribute('aria-expanded', String(open));
        toggle.onclick = () => {
          if (open) collapsed.add(id);
          else collapsed.delete(id);
          rememberCollapsed();
          render();
        };
        const chooser = button('', 'quiet');
        chooser.classList.add('workspace-name');
        chooser.id = 'workspace-name-' + id;
        chooser.title = path;
        if (current) chooser.setAttribute('aria-current', 'location');
        fileLabel(chooser, name, open ? 'folder-open' : 'folder');
        if (labels.get(name) > 1) {
          const shortPath = document.createElement('small');
          shortPath.textContent = path.split(/[/\\]/).filter(Boolean).slice(-3).join('/');
          chooser.append(shortPath);
        }
        chooser.onclick = () => { revealWorkspace(id); options.select(id); };
        const actions = document.createElement('div');
        actions.className = 'workspace-actions';
        const more = iconButton('Actions for ' + name, 'ellipsis');
        more.id = 'workspace-more-' + id;
        more.classList.add('workspace-more');
        more.setAttribute('aria-haspopup', 'menu');
        more.setAttribute('aria-expanded', 'false');
        more.onclick = () => {
          if (menuTrigger === more && !menu.hidden) closeMenu(true);
          else openMenu(record, more);
        };
        const create = iconButton('New in ' + name, 'new-chat');
        create.id = 'workspace-new-' + id;
        create.onclick = () => { closeMenu(); revealWorkspace(id); options.select(id, true); };
        actions.append(more, create);
        row.append(toggle, chooser, actions);
        const entry = document.createElement('li');
        entry.append(row);
        if (open) entry.append(tree.list, branches);
        list.append(entry);
      }
      return list;
    }
    container.replaceChildren(workspaceBranch());
    if (!container.firstElementChild.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'hint workspace-empty';
      empty.textContent = query ? 'No matches' : 'Add a workspace to start a conversation.';
      container.append(empty);
    }
    container.scrollTop = scroll;
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
    selectionChanged();
  }

  state.on('navigation', () => {
    const { sessions, workspaces } = state.get();
    const registered = new Set(workspaces.map(({ id }) => id));
    const available = new Set(sessions.filter(({ workspaceId }) => registered.has(workspaceId)).map(({ id }) => id));
    for (const id of selection) if (!available.has(id)) selection.delete(id);
    const active = state.session();
    if (state.activeConversation && !available.has(state.activeConversation)) options.clearConversation();
    else {
      if (active) options.setTitle(active.title);
      render();
    }
  }, api.signal);
  state.addEventListener('selection', (event: CustomEvent<{ item?: Conversation; revealWorkspace: boolean }>) => {
    const { item, revealWorkspace: workspace } = event.detail;
    if (!item) return;
    if (workspace) revealWorkspace(item.workspaceId);
    for (let parent = item.parentId; parent && !expanded.has(parent); parent = state.session(parent)?.parentId) expanded.add(parent);
  }, { signal: api.signal });

  async function subscribe() {
    let delay = 300;
    while (!api.signal.aborted) {
      try {
        const response = await request('/navigation/events', { signal: api.signal });
        await readEvents<NavigationEvent>(response, (event) => { delay = 300; state.applyNavigation(event); });
      } catch { /* The next connection starts with the current snapshot. */ }
      if (api.signal.aborted) return;
      await wait(delay, api.signal);
      delay = Math.min(delay * 2, 5000);
    }
  }

  element('selectMode').onclick = () => toggleSelection(!selecting);
  element('sessionSearch').oninput = render;
  cancel.onclick = () => toggleSelection(false);
  selectAll.onclick = () => { for (const item of visible) selection.add(item.id); render(); };
  exportButton.onclick = () => void exportSessions([...selection], api.signal).catch(options.report);
  deleteButton.onclick = () => {
    if (confirm('Permanently delete ' + selection.size + ' selected conversations and their descendants?'))
      void remove([...selection]).then(() => toggleSelection(false)).catch(options.report);
  };

  render();
  void subscribe();
}
