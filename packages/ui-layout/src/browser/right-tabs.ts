import { icon } from '@mini-harness/ui-primitives/icons';
import { button, iconButton } from '@mini-harness/ui-primitives/primitives';
import { Service } from 'mini-harness/cordis';
import type { JsonValue, RightPanelEntry, RightTab, RightTabType, TabScope } from './api.ts';

interface TabIdentity {
  type: string;
  key: string;
}

interface TabDescriptor extends TabIdentity {
  data: JsonValue;
}

interface Tab extends TabIdentity {
  id: string;
  resource: { restored: true; data: JsonValue } | { restored: false; data: unknown };
  view?: { node: HTMLElement; controller: AbortController };
  stop?: () => void;
}

interface WorkspaceTabs {
  open: boolean;
  tabs: Tab[];
  active?: Tab;
}

const prefix = 'mini-harness-panel-tabs:';
const inspector = '$inspector';

function readWorkspace(workspaceId: string) {
  const key = prefix + workspaceId;
  const raw = localStorage.getItem(key);
  if (raw === null) return;
  const isIdentity = (value: unknown): value is TabIdentity =>
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    typeof value.type === 'string' &&
    'key' in value &&
    typeof value.key === 'string';
  const isDescriptor = (value: unknown): value is TabDescriptor => isIdentity(value) && 'data' in value;
  try {
    const { open, tabs, active } = JSON.parse(raw);
    if (
      typeof open === 'boolean' &&
      Array.isArray(tabs) &&
      tabs.every(isDescriptor) &&
      new Set(tabs.map(({ type, key }) => JSON.stringify([type, key]))).size === tabs.length &&
      (active === null || isIdentity(active))
    )
      return { open, tabs, active };
  } catch {
    // Discard unreadable data at the storage boundary.
  }
  localStorage.removeItem(key);
}

export function createRightTabs(
  view: {
    root: HTMLElement;
    bar: HTMLElement;
    body: HTMLElement;
    toggle: HTMLButtonElement;
  },
  panelChanged: (focus: boolean) => void,
  signal: AbortSignal,
) {
  const states = new Map<string, WorkspaceTabs>();
  const types = new Map<string, RightTabType<unknown>>();
  const entries = new Set<RightPanelEntry>();
  const workspaceChanges = new EventTarget();
  let scope: TabScope | undefined;
  let emptyOpen = false;
  let nextId = 0;
  let shown: HTMLElement | undefined;
  const nextTabId = () => 'right-tab-' + ++nextId;

  function state(workspaceId: string, initiallyOpen = false) {
    let workspace = states.get(workspaceId);
    if (!workspace) {
      const saved = readWorkspace(workspaceId);
      const tabs = (saved?.tabs ?? []).map(
        ({ type, key, data }): Tab => ({
          id: nextTabId(),
          type,
          key,
          resource: { restored: true, data },
        }),
      );
      workspace = {
        open: saved?.open ?? initiallyOpen,
        tabs,
        active: tabs.find((tab) => tab.type === saved?.active?.type && tab.key === saved.active.key),
      };
      states.set(workspaceId, workspace);
    }
    return workspace;
  }

  function describe(tab: Tab): TabDescriptor | undefined {
    const { type, key, resource } = tab;
    const data = resource.restored ? resource.data : types.get(type)?.persistence?.save(resource.data);
    return data === undefined ? undefined : { type, key, data };
  }

  function persist(workspaceId: string, workspace: WorkspaceTabs) {
    if (signal.aborted) return;
    const descriptions = workspace.tabs.flatMap((tab) => describe(tab) ?? []);
    const active = workspace.active
      ? (descriptions.find(
          (tab) => tab.type === workspace.active?.type && tab.key === workspace.active.key,
        ) ?? descriptions.at(-1))
      : undefined;
    localStorage.setItem(
      prefix + workspaceId,
      JSON.stringify({
        open: workspace.open,
        active: active ? { type: active.type, key: active.key } : null,
        tabs: descriptions,
      }),
    );
  }

  const current = () => scope && states.get(scope.workspaceId);
  const panelOpen = () => current()?.open ?? emptyOpen;
  const home = document.createElement('div');
  home.className = 'right-start';
  const menu = document.createElement('div');
  menu.className = 'right-start-menu';
  home.append(menu);
  const homeTitle = document.createElement('span');
  homeTitle.className = 'right-start-title';
  homeTitle.textContent = 'Start';
  view.bar.before(homeTitle);
  view.body.append(home);

  function visible(workspace: WorkspaceTabs, owner: TabScope) {
    const available: Tab[] = [];
    let removed = false;
    for (const tab of [...workspace.tabs]) {
      const definition = types.get(tab.type);
      if (!definition) continue;
      if (tab.resource.restored) {
        const data = definition.persistence?.restore(tab.resource.data, owner);
        if (data === undefined) {
          remove(workspace, tab);
          removed = true;
          continue;
        }
        tab.resource = { restored: false, data };
      }
      available.push(tab);
    }
    if (removed) persist(owner.workspaceId, workspace);
    return available;
  }

  function render(focus = false) {
    if (signal.aborted) return;
    const owner = scope;
    const workspace = current();
    const tabs = owner && workspace ? visible(workspace, owner) : [];
    const selected = workspace?.active;
    const active = selected && (tabs.includes(selected) ? selected : tabs.at(-1));
    const start = iconButton('Workspace panel home', 'plus');
    start.onclick = () => {
      if (owner && workspace?.active) {
        workspace.active = undefined;
        persist(owner.workspaceId, workspace);
        render(true);
      }
    };
    view.bar.replaceChildren(
      ...tabs.map((tab) => {
        const definition = types.get(tab.type)!;
        const title = definition.title(tab.resource.data);
        const item = document.createElement('div');
        item.className = 'right-tab';
        const select = button(title, 'quiet');
        select.id = tab.id + '-select';
        select.title = title;
        select.setAttribute('role', 'tab');
        select.setAttribute('aria-selected', String(tab === active));
        select.setAttribute('aria-controls', tab.id);
        select.tabIndex = tab === active || (!active && tab === tabs[0]) ? 0 : -1;
        select.onclick = () => activate(tab);
        const close = iconButton('Close tab ' + title, 'close');
        close.onclick = () => {
          if (!workspace || !owner) return;
          remove(workspace, tab);
          persist(owner.workspaceId, workspace);
          render(true);
        };
        item.append(select, close);
        return item;
      }),
    );
    if (tabs.length) view.bar.append(start);
    home.hidden = Boolean(active);
    homeTitle.hidden = Boolean(active);
    menu.replaceChildren(
      ...(owner
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
              card.onclick = () => entry.open(owner);
              return card;
            })
        : []),
    );
    if (owner)
      for (const tab of tabs) {
        if (!tab.view && tab === active && panelOpen()) mount(tab, owner);
        if (tab.view) tab.view.node.hidden = tab !== active;
      }
    const revealed = panelOpen() ? active?.view?.node : undefined;
    if (revealed !== shown) {
      shown = revealed;
      revealed?.dispatchEvent(new Event('tab-activate'));
    }
    if (focus)
      (active
        ? document.getElementById(active.id + '-select')
        : (home.querySelector('button') ?? view.root.querySelector<HTMLElement>('#inspectorClose'))
      )?.focus();
  }

  function activate(tab: Tab) {
    if (!scope) return;
    const workspace = state(scope.workspaceId);
    if (workspace.active !== tab) {
      workspace.active = tab;
      persist(scope.workspaceId, workspace);
    }
    render(true);
  }

  function setPanel(open: boolean, focus = false) {
    if (panelOpen() === open) return;
    if (scope) {
      const workspace = state(scope.workspaceId);
      workspace.open = open;
      persist(scope.workspaceId, workspace);
    } else {
      emptyOpen = open;
    }
    panelChanged(focus);
    render();
  }

  function selectWorkspace(workspaceId?: string) {
    if (scope?.workspaceId === workspaceId) return;
    for (const tab of current()?.tabs ?? []) unmount(tab);
    const open = !scope && emptyOpen;
    emptyOpen = false;
    scope = workspaceId ? { workspaceId } : undefined;
    if (workspaceId) state(workspaceId, open);
    workspaceChanges.dispatchEvent(new Event('change'));
    panelChanged(false);
    render();
  }

  function mount(tab: Tab, owner: TabScope) {
    const controller = new AbortController();
    let node: HTMLElement;
    try {
      node = types.get(tab.type)!.create(tab.resource.data, owner, controller.signal);
    } catch (error) {
      controller.abort();
      node = document.createElement('p');
      node.textContent = error instanceof Error ? error.message : String(error);
    }
    node.id = tab.id;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', tab.id + '-select');
    node.classList.add('right-tab-content');
    view.body.append(node);
    tab.view = { node, controller };
  }

  function unmount(tab: Tab) {
    tab.view?.controller.abort();
    tab.view?.node.remove();
    tab.view = undefined;
  }

  function open<T>(type: string, { owner: { workspaceId }, key, data, signal }: RightTab<T>) {
    if (signal?.aborted) return;
    const target = state(workspaceId);
    let tab = target.tabs.find((item) => item.type === type && item.key === key);
    if (!tab) {
      const created: Tab = { id: nextTabId(), type, key, resource: { restored: false, data } };
      tab = created;
      target.tabs.push(tab);
      if (signal) {
        const close = () => {
          remove(target, created);
          persist(workspaceId, target);
          if (scope?.workspaceId === workspaceId) render();
        };
        signal.addEventListener('abort', close, { once: true });
        created.stop = () => signal.removeEventListener('abort', close);
      }
    }
    if (target.active !== tab || !target.open) {
      target.active = tab;
      target.open = true;
      persist(workspaceId, target);
    }
    if (scope?.workspaceId === workspaceId) {
      panelChanged(true);
      render(true);
    }
  }

  function remove(workspace: WorkspaceTabs, tab: Tab) {
    workspace.tabs.splice(workspace.tabs.indexOf(tab), 1);
    if (workspace.active === tab) workspace.active = workspace.tabs.at(-1);
    tab.stop?.();
    unmount(tab);
  }

  function prune(workspaces: ReadonlySet<string>) {
    if (scope && !workspaces.has(scope.workspaceId)) selectWorkspace();
    for (const [id, target] of states) {
      if (workspaces.has(id)) continue;
      for (const tab of target.tabs) {
        tab.stop?.();
        unmount(tab);
      }
      states.delete(id);
    }
    for (const key of Object.keys(localStorage))
      if (key.startsWith(prefix) && !workspaces.has(key.slice(prefix.length))) localStorage.removeItem(key);
  }

  view.toggle.onclick = () => setPanel(!panelOpen(), true);
  view.bar.addEventListener(
    'keydown',
    (event) => {
      if (!(event.target as HTMLElement).matches('[role=tab]')) return;
      const workspace = current();
      if (!scope || !workspace) return;
      const tabs = visible(workspace, scope);
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
      for (const target of states.values())
        for (const tab of target.tabs) {
          tab.stop?.();
          unmount(tab);
        }
      states.clear();
    },
    { once: true },
  );
  types.set(inspector, {
    title: (data) => (data as { title: string }).title,
    create: (data) => (data as { node: HTMLElement }).node,
  });

  return Service.track({
    selectWorkspace,
    prune,
    panelOpen,
    setPanel,
    register<T>(type: string, definition: RightTabType<T>) {
      if (!type || types.has(type)) throw new Error('Invalid or duplicate tab type: ' + type);
      const owner = Service.caller(this).fiber;
      types.set(type, definition as RightTabType<unknown>);
      owner.effect(() => () => {
        for (const target of states.values()) {
          for (const tab of [...target.tabs]) {
            if (tab.type !== type) continue;
            const descriptor = describe(tab);
            if (!descriptor) remove(target, tab);
            else {
              tab.stop?.();
              tab.stop = undefined;
              unmount(tab);
              tab.resource = { restored: true, data: descriptor.data };
            }
          }
        }
        types.delete(type);
        render();
      });
      render();
      return {
        open(tab: RightTab<T>) {
          if (!owner.signal.aborted) open(type, tab);
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
      const workspace = state(scope.workspaceId);
      const previous = workspace.tabs.find((tab) => tab.type === inspector && tab.key === key);
      if (previous) remove(workspace, previous);
      open(inspector, { owner: scope, key, data: { title, node }, signal });
    },
  });
}
