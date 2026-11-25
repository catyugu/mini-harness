import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import type { SessionSearchResult, Conversation } from '../shared/api.ts';
import type { WorkspaceRecord } from '@mini-harness/workspaces/record';
import { exportSessions } from './session-client.ts';
import type { ConversationSelection, ConversationSessions } from './session-data/api.ts';
import type { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import {
  scopedElements,
  button,
  dialog,
  field,
  fromMarkup,
  iconButton,
  confirmAction,
} from '@mini-harness/ui-primitives/primitives';
import { payload } from '@mini-harness/ui-runtime/http';
import { workspaceTree } from './navigation-tree.ts';
import { sessionTree } from './sessions.ts';
import { fileLabel, icon } from '@mini-harness/ui-primitives/icons';

interface NavigationServices {
  state: ConversationSelection;
  sessions: ConversationSessions;
  workspaces: RemoteStore<WorkspaceRecord[]>;
  activate(id: string): void;
  select(id: string, draft?: boolean): void;
  chooseWorkspace(onAdd: (record: WorkspaceRecord) => void): void;
  renameWorkspace(record: WorkspaceRecord): void;
  removeWorkspace(record: WorkspaceRecord): Promise<void>;
  clearConversation(): void;
  report(error: Error): void;
  setTitle(title: string): void;
}

export function sessionNavigation(ctx: Context, options: NavigationServices) {
  const signal = ctx.fiber.signal;
  const { state, sessions: sessionStore, workspaces: workspaceStore } = options;
  const panel = fromMarkup(`<div class="session-navigation">
    <div class="sidebar-caption">
      <span>Workspaces</span>
      <div id="workspaceActions"></div>
    </div>
    <input id="sessionSearch" class="ui-input" type="search" placeholder="Search workspaces and chats" aria-label="Search workspaces and conversations" hidden>
    <nav id="sessions" class="sessions" aria-label="Conversation tree"></nav>
    <div id="bulkActions" class="bulk-actions" hidden>
      <span id="selectedCount" aria-live="polite"></span>
    </div>
  </div>`);
  ctx.effect(() => ctx.miniSlots.register('sidebar.navigation', panel));
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
  ctx.effect(() => ctx.miniSlots.register('dialog.root', renameDialog));
  let renaming: string;
  const selection = new Set<string>(),
    expanded = new Set<string>();
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
  ctx.effect(() => ctx.miniSlots.register('dialog.root', menu));
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
    renameAction.onclick = () => {
      closeMenu();
      options.renameWorkspace(record);
    };
    removeAction.onclick = () => {
      closeMenu();
      void options.removeWorkspace(record).catch(options.report);
    };
    menu.hidden = false;
    const anchor = trigger.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)) + 'px';
    const below = anchor.bottom + 4;
    menu.style.top =
      (below + bounds.height > innerHeight - 8 ? Math.max(8, anchor.top - bounds.height - 4) : below) + 'px';
    renameAction.focus({ preventScroll: true });
  }
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (
        !menu.hidden &&
        event.target instanceof Node &&
        !menu.contains(event.target) &&
        !menuTrigger?.contains(event.target)
      )
        closeMenu();
    },
    { signal },
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape' && !menu.hidden) {
        event.preventDefault();
        closeMenu(true);
      }
    },
    { signal },
  );
  window.addEventListener('resize', () => closeMenu(), { signal });
  element('sessions').addEventListener('scroll', () => closeMenu(), { signal });

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
  let contentMatches = new Map<string, SessionSearchResult>();
  let searchRequest: AbortController | undefined;
  let searchRevision = 0;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const selectAll = button('Select all');
  const exportButton = button('Export');
  const deleteButton = button('Delete', 'danger');
  const cancel = button('Cancel', 'quiet');
  element('bulkActions').append(selectAll, exportButton, deleteButton, cancel);
  const searchInput = element<'input'>('sessionSearch');
  const searchToggle = iconButton('Search workspaces and conversations', 'search');
  searchToggle.id = 'searchToggle';
  searchToggle.setAttribute('aria-controls', 'sessionSearch');
  searchToggle.setAttribute('aria-expanded', 'false');
  const selectMode = iconButton('Select conversations', 'list-checks');
  selectMode.id = 'selectMode';
  selectMode.setAttribute('aria-pressed', 'false');
  const addWorkspace = iconButton('Add workspace', 'plus');
  element('workspaceActions').append(searchToggle, selectMode, addWorkspace);
  addWorkspace.onclick = () =>
    options.chooseWorkspace((record) => {
      void workspaceStore
        .refresh()
        .then(() => {
          revealWorkspace(record.id);
          options.select(record.id);
        })
        .catch(options.report);
    });

  async function remove(ids: string[]) {
    await browserRequest(ctx, '/sessions/delete', payload('POST', { ids }));
    await sessionStore.refresh();
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
      await browserRequest(ctx, '/sessions/' + renaming, payload('PATCH', { title: title.value }));
      renameDialog.close();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      save.disabled = false;
    }
  };

  function selectionChanged() {
    selectMode.setAttribute('aria-pressed', String(selecting));
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
    const parents = workspaceTree(workspaceStore.get()).parents;
    for (let cursor: string | undefined = id; cursor; cursor = parents.get(cursor)) collapsed.delete(cursor);
    rememberCollapsed();
  }

  function render() {
    const sessions = sessionStore.get(),
      workspaces = workspaceStore.get();
    const query = value('sessionSearch').toLowerCase();
    const container = element('sessions');
    const focused = document.activeElement;
    const focus = focused instanceof HTMLElement && container.contains(focused) ? focused.id : '';
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
      const ids = workspaces.map(({ id }) => (siblingSet.has(id) ? moved[next++] : id));
      try {
        await browserRequest(ctx, '/workspaces', payload('PUT', { ids }));
        await workspaceStore.refresh();
      } catch (error) {
        options.report(error instanceof Error ? error : new Error(String(error)));
      }
    }
    function sessionBranch(items: Conversation[], matches: boolean) {
      return sessionTree(items, {
        active: state.activeConversation,
        expanded,
        selection,
        selecting,
        query: matches ? '' : query,
        highlight: query,
        matches: contentMatches,
        render,
        selectionChanged,
        activate: options.activate,
        rename,
        remove(item) {
          void confirmAction('Permanently delete "' + item.title + '" and all child conversations?', {
            title: 'Delete conversation',
            signal,
          })
            .then((confirmed) => (confirmed ? remove([item.id]) : undefined))
            .catch(options.report);
        },
      });
    }
    function workspaceBranch(parent?: string) {
      const list = document.createElement('ul');
      list.className = 'workspace-branch';
      for (const record of children.get(parent) ?? []) {
        const { id, name, path } = record;
        const matches = !query || name.toLowerCase().includes(query) || path.toLowerCase().includes(query);
        const current = state.selectedWorkspace === id;
        const tree = sessionBranch(grouped.get(id) ?? [], matches);
        const branches = workspaceBranch(id);
        if (!matches && !tree.visible.length && !branches.childElementCount) continue;
        visible.push(...tree.visible);
        const open = !collapsed.has(id) || Boolean(query);
        const row = document.createElement('div');
        row.className = 'workspace-row';
        row.dataset.workspaceId = id;
        row.draggable = !selecting && !query;
        row.ondragstart = (event) => {
          if (
            !row.draggable ||
            (event.target instanceof Element && event.target.closest('.workspace-actions, .tree-button'))
          ) {
            event.preventDefault();
            return;
          }
          closeMenu();
          draggingWorkspace = id;
          row.classList.add('workspace-dragging');
          if (!event.dataTransfer) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', id);
        };
        row.ondragover = (event) => {
          if (
            !draggingWorkspace ||
            draggingWorkspace === id ||
            parents.get(draggingWorkspace) !== parents.get(id)
          )
            return;
          event.preventDefault();
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
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
        const toggle = iconButton(
          (open ? 'Collapse workspace ' : 'Expand workspace ') + name,
          'triangle',
          'tree-button',
        );
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
        if ((labels.get(name) ?? 0) > 1) {
          const shortPath = document.createElement('small');
          shortPath.textContent = path.split(/[/\\]/).filter(Boolean).slice(-3).join('/');
          chooser.append(shortPath);
        }
        chooser.onclick = () => {
          revealWorkspace(id);
          options.select(id);
        };
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
        create.onclick = () => {
          closeMenu();
          revealWorkspace(id);
          options.select(id, true);
        };
        actions.append(more, create);
        row.append(toggle, chooser, actions);
        const entry = document.createElement('li');
        entry.append(row);
        if (open) entry.append(tree.list, branches);
        list.append(entry);
      }
      return list;
    }
    const tree = workspaceBranch();
    const unbound = sessionBranch(grouped.get(null) ?? [], false);
    if (unbound.visible.length) {
      visible.push(...unbound.visible);
      const section = document.createElement('li');
      const heading = document.createElement('span');
      heading.className = 'workspace-name';
      heading.textContent = 'Without workspace';
      section.append(heading, unbound.list);
      tree.append(section);
    }
    container.replaceChildren(tree);
    if (!tree.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'hint workspace-empty';
      empty.textContent = query ? 'No matches' : 'Add a workspace to start a conversation.';
      container.append(empty);
    }
    container.scrollTop = scroll;
    if (focus) document.getElementById(focus)?.focus({ preventScroll: true });
    selectionChanged();
  }

  function update() {
    const sessions = sessionStore.get(),
      workspaces = workspaceStore.get();
    const registered = new Set(workspaces.map(({ id }) => id));
    const available = new Set(
      sessions
        .filter(({ workspaceId }) => workspaceId === null || registered.has(workspaceId))
        .map(({ id }) => id),
    );
    for (const id of selection) if (!available.has(id)) selection.delete(id);
    const active = sessions.find(({ id }) => id === state.activeConversation);
    if (state.activeConversation && !available.has(state.activeConversation)) options.clearConversation();
    else {
      if (active) options.setTitle(active.title);
      render();
    }
  }
  state.subscribe(update, signal);
  sessionStore.subscribe(update, signal);
  state.addEventListener(
    'selection',
    (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const { item, revealWorkspace: workspace } = event.detail as {
        item?: Conversation;
        revealWorkspace: boolean;
      };
      if (!item) return;
      if (workspace && item.workspaceId) revealWorkspace(item.workspaceId);
      for (
        let parent = item.parentId;
        parent && !expanded.has(parent);
        parent = sessionStore.get().find(({ id }) => id === parent)?.parentId ?? null
      )
        expanded.add(parent);
    },
    { signal },
  );

  selectMode.onclick = () => toggleSelection(!selecting);
  function updateSearch() {
    const query = value('sessionSearch');
    const revision = ++searchRevision;
    clearTimeout(searchTimer);
    searchRequest?.abort();
    contentMatches = new Map();
    render();
    if (query.length < 2) return;
    searchTimer = setTimeout(() => {
      const request = (searchRequest = new AbortController());
      void browserRequest<SessionSearchResult[]>(ctx, '/sessions/search?q=' + encodeURIComponent(query), {
        signal: request.signal,
      })
        .then((hits) => {
          if (request.signal.aborted || revision !== searchRevision) return;
          contentMatches = new Map(hits.map((hit) => [hit.id, hit]));
          render();
        })
        .catch((error) => {
          if (!request.signal.aborted && revision === searchRevision) options.report(error);
        });
    }, 250);
  }
  searchInput.oninput = updateSearch;
  searchToggle.onclick = () => {
    const open = searchInput.hidden;
    searchInput.hidden = !open;
    searchToggle.setAttribute('aria-expanded', String(open));
    if (open) searchInput.focus();
    else {
      searchInput.value = '';
      updateSearch();
      searchToggle.focus();
    }
  };
  searchInput.onkeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      searchToggle.click();
      searchToggle.focus();
    }
  };
  ctx.effect(() => () => {
    clearTimeout(searchTimer);
    searchRequest?.abort();
  });
  cancel.onclick = () => toggleSelection(false);
  selectAll.onclick = () => {
    for (const item of visible) selection.add(item.id);
    render();
  };
  exportButton.onclick = () => void exportSessions([...selection], signal).catch(options.report);
  deleteButton.onclick = () => {
    const ids = [...selection];
    void confirmAction(
      'Permanently delete ' + ids.length + ' selected conversations and their descendants?',
      { title: 'Delete conversations', signal },
    )
      .then(async (confirmed) => {
        if (!confirmed) return;
        await remove(ids);
        toggleSelection(false);
      })
      .catch(options.report);
  };

  render();
}
