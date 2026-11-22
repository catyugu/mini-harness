import { button, iconButton } from './primitives.js';
import type { createLayout } from './layout.js';

export interface TabScope { workspaceId: string; sessionId?: string }
export interface TabAddress extends TabScope { type: string; path?: string }
export interface RightTabType {
  title(address: TabAddress): string;
  create(address: TabAddress, signal: AbortSignal): HTMLElement;
  launcher?: string;
  default?: boolean;
}

type Tab = { key: string; title: string; address?: TabAddress };
type ScopeTabs = { scope?: TabScope; open: boolean; active?: string; tabs: Map<string, Tab> };
const scopeKey = (scope?: TabScope) => JSON.stringify([scope?.workspaceId, scope?.sessionId]);

export function createRightTabs(view: {
  root: HTMLElement; bar: HTMLElement; launchers: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement;
}, layout: ReturnType<typeof createLayout>, signal: AbortSignal) {
  const types = new Map<string, RightTabType>();
  const states = new Map<string, ScopeTabs>();
  const mounted = new Map<Tab, { node: HTMLElement; controller: AbortController }>();
  let current = state();
  let nextId = 0;

  function state(scope?: TabScope) {
    const key = scopeKey(scope);
    if (!states.has(key)) states.set(key, { scope, open: false, tabs: new Map() });
    return states.get(key);
  }

  function render(focus = false) {
    const active = [...current.tabs.values()].find(({ key }) => key === current.active);
    const entries = [...current.tabs.values()];
    view.bar.replaceChildren(...entries.map((tab) => {
      const item = document.createElement('div');
      item.className = 'right-tab';
      const select = button(tab.title, 'quiet');
      select.id = tab.key + '-select';
      select.title = tab.address?.path ?? tab.title;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab === active));
      select.setAttribute('aria-controls', tab.key);
      select.tabIndex = tab === active ? 0 : -1;
      select.onclick = () => { current.active = tab.key; render(true); };
      const close = iconButton('Close tab ' + tab.title, 'close');
      close.onclick = () => { remove(current, tab.key); render(true); };
      item.append(select, close);
      return item;
    }));
    for (const tab of entries) {
      const node = mounted.get(tab)?.node ?? mount(tab, (signal) => types.get(tab.address.type).create(tab.address, signal));
      node.hidden = tab !== active;
      if (node.parentElement !== view.body) view.body.append(node);
    }
    view.launchers.replaceChildren(...[...types].flatMap(([id, type]) => {
      if (!current.scope || !type.launcher) return [];
      const control = button(type.launcher, 'quiet');
      control.onclick = () => open(id);
      return [control];
    }));
    if (focus) (active ? document.getElementById(active.key + '-select') : view.root.querySelector<HTMLElement>('#inspectorClose'))?.focus();
  }

  function selectScope(scope?: TabScope) {
    if (scopeKey(scope) === scopeKey(current.scope)) return;
    current.open = layout.panelOpen();
    for (const tab of current.tabs.values()) {
      if (tab.address) unmount(tab);
      else remove(current, tab.key);
    }
    current = state(scope);
    render();
    layout.setPanel(current.open);
  }

  function mount(tab: Tab, create: (signal: AbortSignal) => HTMLElement) {
    const controller = new AbortController();
    let node: HTMLElement;
    try { node = create(controller.signal); }
    catch (error) {
      controller.abort();
      node = document.createElement('p');
      node.textContent = error instanceof Error ? error.message : String(error);
    }
    node.id = tab.key;
    node.setAttribute('role', 'tabpanel');
    node.setAttribute('aria-labelledby', tab.key + '-select');
    node.classList.add('right-tab-content');
    mounted.set(tab, { node, controller });
    return node;
  }

  function unmount(tab: Tab) {
    const view = mounted.get(tab);
    mounted.delete(tab);
    view?.controller.abort();
    view?.node.remove();
  }

  function reveal(tab: Tab) {
    current.active = tab.key;
    layout.closeDrawer(false);
    layout.setPanel(true, true);
    render(true);
  }

  function open(type: string, path?: string, scope = current.scope) {
    const definition = types.get(type);
    if (!definition || !scope) return;
    const target = state(scope);
    let tab = [...target.tabs.values()].find(({ address }) => address?.type === type && address.path === path);
    if (!tab) {
      const address = { ...scope, type, path };
      tab = { key: 'right-tab-' + ++nextId, title: definition.title(address), address };
      target.tabs.set(tab.key, tab);
    }
    target.active = tab.key;
    if (target === current) reveal(tab);
  }

  function remove(target: ScopeTabs, key: string) {
    const tab = target.tabs.get(key);
    if (!tab) return;
    const keys = [...target.tabs.keys()];
    target.tabs.delete(key);
    if (target.active === key) {
      const index = keys.indexOf(key);
      target.active = keys[index + 1] ?? keys[index - 1];
    }
    unmount(tab);
  }

  function prune(sessions: ReadonlySet<string>, workspaces: ReadonlySet<string>) {
    for (const [key, target] of states) {
      const scope = target.scope;
      if (!scope || (workspaces.has(scope.workspaceId) && (!scope.sessionId || sessions.has(scope.sessionId)))) continue;
      for (const id of target.tabs.keys()) remove(target, id);
      states.delete(key);
      if (target === current) selectScope();
    }
  }

  view.toggle.onclick = () => {
    if (!layout.panelOpen() && !current.tabs.size && current.scope) {
      const entry = [...types].find(([, type]) => type.default);
      if (entry) { open(entry[0]); return; }
    }
    layout.setPanel(!layout.panelOpen(), true);
  };
  view.bar.addEventListener('keydown', (event) => {
    if (!(event.target as HTMLElement).matches('[role=tab]')) return;
    const tabs = [...current.tabs.values()];
    const index = tabs.findIndex(({ key }) => key === current.active);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length :
        event.key === 'ArrowRight' ? (index + 1) % tabs.length : undefined;
    if (target === undefined) return;
    event.preventDefault();
    current.active = tabs[target].key;
    render(true);
  }, { signal });
  signal.addEventListener('abort', () => {
    for (const tab of mounted.keys()) unmount(tab);
    states.clear();
  }, { once: true });

  return {
    selectScope, open, prune,
    register(type: string, definition: RightTabType) {
      if (types.has(type)) throw new Error('Duplicate right panel tab type: ' + type);
      types.set(type, definition);
      render();
      return () => {
        types.delete(type);
        for (const target of states.values()) for (const tab of target.tabs.values()) {
          if (tab.address?.type === type) remove(target, tab.key);
        }
        render();
      };
    },
    inspect(owner: string, title: string, node: HTMLElement, signal: AbortSignal) {
      const target = current;
      const key = 'inspect-' + owner;
      remove(target, key);
      const tab = { key, title };
      target.tabs.set(key, tab);
      mount(tab, () => node);
      signal.addEventListener('abort', () => {
        remove(target, key);
        if (target === current) render();
      }, { once: true, signal: mounted.get(tab).controller.signal });
      reveal(tab);
    }
  };
}
