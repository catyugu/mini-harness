import { icon } from '@mini-harness/ui-primitives/icons';
import { button, iconButton } from '@mini-harness/ui-primitives/primitives';
import { Service } from 'mini-harness/cordis';
import type { createLayout } from './layout.ts';
import type { RightPanelEntry, RightTab, RightTabType, TabScope } from './api.ts';

interface Tab {
  id: string;
  type: symbol;
  key: string;
  owner: TabScope;
  title: string;
  create(scope: TabScope, signal: AbortSignal): HTMLElement;
  view?: { node: HTMLElement; controller: AbortController; scroll?: { top: number; left: number } };
  stop?: () => void;
}

interface WorkspaceTabs {
  rememberedOpen: boolean;
  tabs: Tab[];
  active?: Tab;
}

export function createRightTabs(
  view: {
    root: HTMLElement;
    bar: HTMLElement;
    body: HTMLElement;
    toggle: HTMLButtonElement;
  },
  layout: ReturnType<typeof createLayout>,
  signal: AbortSignal,
) {
  const states = new Map<string, WorkspaceTabs>();
  const entries = new Set<RightPanelEntry>();
  const workspaceChanges = new EventTarget();
  let scope: TabScope | undefined;
  let nextId = 0;
  let shown: HTMLElement | undefined;
  const inspector = Symbol('inspector');

  const state = (id: string) => {
    let workspace = states.get(id);
    if (!workspace) {
      workspace = { rememberedOpen: false, tabs: [] };
      states.set(id, workspace);
    }
    return workspace;
  };
  const current = () => scope && states.get(scope.workspaceId);
  const visible = () => current()?.tabs ?? [];
  const home = document.createElement('div');
  home.className = 'right-start';
  const menu = document.createElement('div');
  menu.className = 'right-start-menu';
  home.append(menu);
  const homeTitle = document.createElement('span');
  homeTitle.className = 'right-start-title';
  homeTitle.textContent = 'Start';
  view.bar.before(homeTitle);

  function render(focus = false) {
    const tabs = visible();
    const active = current()?.active;
    const start = iconButton('Workspace panel home', 'plus');
    start.onclick = () => {
      const workspace = current();
      if (workspace) workspace.active = undefined;
      render(true);
    };
    view.bar.replaceChildren(
      ...tabs.map((tab) => {
        const item = document.createElement('div');
        item.className = 'right-tab ui-row';
        const select = button(tab.title, 'quiet');
        select.classList.add('ui-truncate');
        select.id = tab.id + '-select';
        select.title = tab.title;
        select.setAttribute('role', 'tab');
        select.setAttribute('aria-selected', String(tab === active));
        select.setAttribute('aria-controls', tab.id);
        select.tabIndex = tab === active || (!active && tab === tabs[0]) ? 0 : -1;
        select.onclick = () => activate(tab);
        const close = iconButton('Close tab ' + tab.title, 'close');
        close.classList.add('ui-fixed');
        close.onclick = () => {
          remove(tab);
          render(true);
        };
        item.append(select, close);
        return item;
      }),
    );
    if (tabs.length) view.bar.append(start);
    home.hidden = Boolean(active);
    homeTitle.hidden = Boolean(active);
    const selectedScope = scope;
    menu.replaceChildren(
      ...(selectedScope
        ? [...entries]
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
            .map((entry) => {
              const card = button('');
              const label = document.createElement('span');
              const title = document.createElement('strong');
              title.textContent = entry.title;
              const description = document.createElement('small');
              description.textContent = entry.description;
              label.append(title, description);
              card.append(icon(entry.icon), label);
              card.onclick = () => entry.open(selectedScope);
              return card;
            })
        : []),
    );
    if (home.parentElement !== view.body) view.body.append(home);
    if (selectedScope)
      for (const tab of tabs) {
        if (!tab.view && tab === active) mount(tab, selectedScope);
        if (!tab.view) continue;
        tab.view.node.hidden = tab !== active;
        if (tab.view.node.parentElement !== view.body) view.body.append(tab.view.node);
        if (tab === active && tab.view.scroll) {
          tab.view.node.scrollTo(tab.view.scroll);
          tab.view.scroll = undefined;
        }
      }
    revealActive();
    if (focus)
      (active
        ? document.getElementById(active.id + '-select')
        : (home.querySelector('button') ?? view.root.querySelector<HTMLElement>('#inspectorClose'))
      )?.focus();
  }

  function revealActive() {
    const node = current()?.active?.view?.node;
    const active = layout.panelOpen() && node?.isConnected && !node.hidden ? node : undefined;
    if (shown === active) return;
    shown = active;
    active?.dispatchEvent(new Event('tab-activate'));
  }

  function activate(tab: Tab) {
    const workspace = current();
    if (workspace) workspace.active = tab;
    render(true);
  }

  function selectWorkspace(workspaceId?: string) {
    if (scope?.workspaceId === workspaceId) return;
    const workspace = current();
    const open = layout.panelOpen();
    if (workspace) {
      workspace.rememberedOpen = open;
      for (const tab of workspace.tabs) {
        if (!tab.view) continue;
        const { node } = tab.view;
        if (!node.hidden) tab.view.scroll = { top: node.scrollTop, left: node.scrollLeft };
        node.remove();
      }
    }
    const openedBeforeSelection = !scope && open;
    scope = workspaceId ? { workspaceId } : undefined;
    const restoreOpen = workspaceId ? openedBeforeSelection || state(workspaceId).rememberedOpen : false;
    workspaceChanges.dispatchEvent(new Event('change'));
    layout.setPanel(restoreOpen);
    render();
  }

  function mount(tab: Tab, scope: TabScope) {
    const controller = new AbortController();
    let node: HTMLElement;
    try {
      node = tab.create(scope, controller.signal);
    } catch (error) {
      controller.abort();
      node = document.createElement('p');
      node.textContent = error instanceof Error ? error.message : String(error);
    }
    node.id = tab.id;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', tab.id + '-select');
    node.classList.add('right-tab-content');
    tab.view = { node, controller };
  }

  function unmount(tab: Tab) {
    tab.view?.controller.abort();
    tab.view?.node.remove();
    tab.view = undefined;
  }

  function open<T>(type: symbol, definition: RightTabType<T>, { owner, key, data, signal }: RightTab<T>) {
    if (signal?.aborted) return;
    const target = state(owner.workspaceId);
    let tab = target.tabs.find((item) => item.type === type && item.key === key);
    if (!tab) {
      const created: Tab = {
        id: 'right-tab-' + ++nextId,
        type,
        key,
        owner: { ...owner },
        title: definition.title(data),
        create: (scope, signal) => definition.create(data, scope, signal),
      };
      tab = created;
      target.tabs.push(tab);
      if (signal) {
        const close = () => {
          remove(created);
          render();
        };
        signal.addEventListener('abort', close, { once: true });
        created.stop = () => signal.removeEventListener('abort', close);
      }
    }
    if (visible().includes(tab)) {
      layout.closeDrawer(false);
      target.active = tab;
      layout.setPanel(true, true);
      render(true);
    } else {
      target.active = tab;
      target.rememberedOpen = true;
    }
  }

  function remove(tab: Tab) {
    const target = states.get(tab.owner.workspaceId);
    const index = target?.tabs.indexOf(tab) ?? -1;
    if (!target || index < 0) return;
    target.tabs.splice(index, 1);
    if (target.active === tab) target.active = target.tabs.at(-1);
    tab.stop?.();
    unmount(tab);
  }

  function prune(workspaces: ReadonlySet<string>) {
    if (scope && !workspaces.has(scope.workspaceId)) selectWorkspace();
    for (const [id, target] of states) {
      if (workspaces.has(id)) continue;
      for (const tab of [...target.tabs]) remove(tab);
      states.delete(id);
    }
  }

  layout.onPanelVisibilityChange(revealActive);
  view.toggle.onclick = () => layout.setPanel(!layout.panelOpen(), true);
  view.bar.addEventListener(
    'keydown',
    (event) => {
      if (!(event.target as HTMLElement).matches('[role=tab]')) return;
      const tabs = visible();
      const index = [...view.bar.querySelectorAll('[role=tab]')].indexOf(event.target as Element);
      const target =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? tabs.length - 1
            : event.key === 'ArrowLeft'
              ? (index + tabs.length - 1) % tabs.length
              : event.key === 'ArrowRight'
                ? (index + 1) % tabs.length
                : undefined;
      if (target === undefined) return;
      event.preventDefault();
      activate(tabs[target]);
    },
    { signal },
  );
  signal.addEventListener(
    'abort',
    () => {
      for (const target of states.values()) for (const tab of [...target.tabs]) remove(tab);
      states.clear();
    },
    { once: true },
  );

  return Service.track({
    selectWorkspace,
    prune,
    register<T>(type: string, definition: RightTabType<T>) {
      const identity = Symbol(type);
      const owner = Service.caller(this).fiber;
      const signal = owner.signal;
      owner.effect(() => () => {
        for (const target of states.values())
          for (const tab of [...target.tabs]) if (tab.type === identity) remove(tab);
        render();
      });
      return {
        open(tab: RightTab<T>) {
          if (!signal.aborted) open(identity, definition, tab);
        },
      };
    },
    contribute(id: string, entry: RightPanelEntry) {
      Service.caller(this).effect(() => {
        entries.add(entry);
        render();
        return () => {
          entries.delete(entry);
          render();
        };
      }, 'Workspace panel entry: ' + id);
    },
    onWorkspaceChange(listener: () => void, signal: AbortSignal) {
      workspaceChanges.addEventListener('change', listener, { signal });
      return () => workspaceChanges.removeEventListener('change', listener);
    },
    inspect(title: string, node: HTMLElement, lifetime: AbortSignal) {
      if (!scope) return;
      const owner = Service.caller(this).fiber;
      const key = String(owner.uid);
      const signal = AbortSignal.any([owner.signal, lifetime]);
      if (signal.aborted) return;
      const previous = visible().find((tab) => tab.type === inspector && tab.key === key);
      if (previous) remove(previous);
      open(
        inspector,
        { title: () => title, create: () => node },
        {
          owner: { ...scope },
          key,
          data: undefined,
          signal,
        },
      );
    },
  });
}
