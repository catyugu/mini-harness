import { button, iconButton } from './primitives.js';
import type { createLayout } from '../shell/layout.js';

export interface TabScope { workspaceId: string; sessionId?: string }
export interface TabAddress extends TabScope { type: string; path?: string }
export interface RightTabType {
  title(address: TabAddress): string;
  create(address: TabAddress, signal: AbortSignal): HTMLElement;
  default?: boolean;
}

type Tab = {
  key: string;
  title: string;
  address?: TabAddress;
  view?: { node: HTMLElement; controller: AbortController };
};
type ScopeTabs = { scope?: TabScope; open: boolean; active?: Tab; tabs: Tab[] };
const scopeKey = (scope?: TabScope) => JSON.stringify([scope?.workspaceId, scope?.sessionId]);

export function createRightTabs(view: {
  root: HTMLElement; bar: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement;
}, layout: ReturnType<typeof createLayout>, signal: AbortSignal) {
  const types = new Map<string, RightTabType>();
  const states = new Map<string, ScopeTabs>();
  let current = state();
  let nextId = 0;

  function state(scope?: TabScope) {
    const key = scopeKey(scope);
    if (!states.has(key)) states.set(key, { scope, open: false, tabs: [] });
    return states.get(key);
  }

  function render(focus = false) {
    const { active, tabs } = current;
    view.bar.replaceChildren(...tabs.map((tab) => {
      const item = document.createElement('div');
      item.className = 'right-tab';
      const select = button(tab.title, 'quiet');
      select.id = tab.key + '-select';
      select.title = tab.address?.path ?? tab.title;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab === active));
      select.setAttribute('aria-controls', tab.key);
      select.tabIndex = tab === active ? 0 : -1;
      select.onclick = () => { current.active = tab; render(true); };
      const close = iconButton('Close tab ' + tab.title, 'close');
      close.onclick = () => { remove(current, tab); render(true); };
      item.append(select, close);
      return item;
    }));
    for (const tab of tabs) {
      const node = tab.view?.node ?? mount(tab, (signal) => types.get(tab.address.type).create(tab.address, signal));
      node.hidden = tab !== active;
      if (node.parentElement !== view.body) view.body.append(node);
    }
    if (focus) (active ? document.getElementById(active.key + '-select') : view.root.querySelector<HTMLElement>('#inspectorClose'))?.focus();
  }

  function selectScope(scope?: TabScope) {
    if (scopeKey(scope) === scopeKey(current.scope)) return;
    current.open = layout.panelOpen();
    for (const tab of [...current.tabs]) {
      if (tab.address) unmount(tab);
      else remove(current, tab);
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
    tab.view = { node, controller };
    return node;
  }

  function unmount(tab: Tab) {
    tab.view?.controller.abort();
    tab.view?.node.remove();
    tab.view = undefined;
  }

  function reveal(tab: Tab) {
    current.active = tab;
    layout.closeDrawer(false);
    layout.setPanel(true, true);
    render(true);
  }

  function open(type: string, path?: string, scope = current.scope) {
    const definition = types.get(type);
    if (!definition || !scope) return;
    const target = state(scope);
    let tab = target.tabs.find(({ address }) => address?.type === type && address.path === path);
    if (!tab) {
      const address = { ...scope, type, path };
      tab = { key: 'right-tab-' + ++nextId, title: definition.title(address), address };
      target.tabs.push(tab);
    }
    target.active = tab;
    if (target === current) reveal(tab);
  }

  function remove(target: ScopeTabs, tab: Tab) {
    const index = target.tabs.indexOf(tab);
    if (index === -1) return;
    target.tabs.splice(index, 1);
    if (target.active === tab) target.active = target.tabs[index] ?? target.tabs[index - 1];
    unmount(tab);
  }

  function prune(sessions: ReadonlySet<string>, workspaces: ReadonlySet<string>) {
    for (const [key, target] of states) {
      const scope = target.scope;
      if (!scope || (workspaces.has(scope.workspaceId) && (!scope.sessionId || sessions.has(scope.sessionId)))) continue;
      for (const tab of target.tabs) unmount(tab);
      states.delete(key);
      if (target === current) selectScope();
    }
  }

  view.toggle.onclick = () => {
    if (!layout.panelOpen() && !current.tabs.length && current.scope) {
      const entry = [...types].find(([, type]) => type.default);
      if (entry) { open(entry[0]); return; }
    }
    layout.setPanel(!layout.panelOpen(), true);
  };
  view.bar.addEventListener('keydown', (event) => {
    if (!(event.target as HTMLElement).matches('[role=tab]')) return;
    const { tabs } = current;
    const index = tabs.indexOf(current.active);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length :
        event.key === 'ArrowRight' ? (index + 1) % tabs.length : undefined;
    if (target === undefined) return;
    event.preventDefault();
    current.active = tabs[target];
    render(true);
  }, { signal });
  signal.addEventListener('abort', () => {
    for (const tab of current.tabs) unmount(tab);
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
        for (const target of states.values()) for (const tab of [...target.tabs]) {
          if (tab.address?.type === type) remove(target, tab);
        }
        render();
      };
    },
    inspect(owner: string, title: string, node: HTMLElement, signal: AbortSignal) {
      const target = current;
      const key = 'inspect-' + owner;
      const previous = target.tabs.find((tab) => tab.key === key);
      if (previous) remove(target, previous);
      const tab = { key, title, view: undefined };
      target.tabs.push(tab);
      mount(tab, () => node);
      signal.addEventListener('abort', () => {
        remove(target, tab);
        if (target === current) render();
      }, { once: true, signal: tab.view.controller.signal });
      reveal(tab);
    }
  };
}
