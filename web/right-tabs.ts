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

type Tab = { key: string; title: string; path?: string; node: HTMLElement; type: string; controller: AbortController };
type ScopeTabs = { scope?: TabScope; open: boolean; active?: string; tabs: Map<string, Tab> };
const scopeKey = (scope?: TabScope) => JSON.stringify([scope?.workspaceId, scope?.sessionId]);

export function createRightTabs(view: {
  root: HTMLElement; bar: HTMLElement; launchers: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement;
}, layout: ReturnType<typeof createLayout>, signal: AbortSignal) {
  const types = new Map<string, RightTabType>();
  const states = new Map<string, ScopeTabs>();
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
      select.title = tab.path ?? tab.title;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab === active));
      select.setAttribute('aria-controls', tab.key);
      select.tabIndex = tab === active ? 0 : -1;
      select.onclick = () => { current.active = tab.key; render(true); };
      const close = iconButton('Close tab ' + tab.title, 'close');
      close.onclick = () => { remove(current, tab); render(true); };
      item.append(select, close);
      return item;
    }));
    const nodes = new Set(entries.map(({ node }) => node));
    for (const child of [...view.body.children]) if (!nodes.has(child as HTMLElement)) child.remove();
    for (const tab of entries) {
      tab.node.hidden = tab !== active;
      if (tab.node.parentElement !== view.body) view.body.append(tab.node);
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
    current = state(scope);
    render();
    layout.setPanel(current.open);
  }

  function add(target: ScopeTabs, identity: string, type: string, title: string, create: (signal: AbortSignal) => HTMLElement, reveal: boolean, path?: string) {
    let tab = target.tabs.get(identity);
    if (!tab) {
      const controller = new AbortController();
      const node = create(controller.signal);
      const key = 'right-tab-' + ++nextId;
      node.id = key;
      node.setAttribute('role', 'tabpanel');
      node.setAttribute('aria-labelledby', key + '-select');
      node.classList.add('right-tab-content');
      tab = { key, title, path, type, node, controller };
      target.tabs.set(identity, tab);
    }
    target.active = tab.key;
    if (target === current && reveal) {
      layout.closeDrawer(false);
      layout.setPanel(true, true);
      render(true);
    }
    return tab;
  }

  function open(type: string, path?: string, scope = current.scope) {
    const definition = types.get(type);
    if (!definition || !scope) return;
    const address = { ...scope, type, path };
    const target = state(scope);
    const identity = JSON.stringify([type, path ?? '']);
    add(target, identity, type, definition.title(address), (signal) => definition.create(address, signal), target === current, path);
  }

  function remove(target: ScopeTabs, tab: Tab) {
    const entries = [...target.tabs.entries()];
    const index = entries.findIndex(([, item]) => item === tab);
    if (index < 0) return;
    target.tabs.delete(entries[index][0]);
    tab.controller.abort();
    tab.node.remove();
    if (target.active === tab.key) target.active = (entries[index + 1] ?? entries[index - 1])?.[1].key;
  }

  function prune(sessions: ReadonlySet<string>, workspaces: ReadonlySet<string>) {
    let changed = false;
    for (const [key, target] of states) {
      const scope = target.scope;
      if (!scope || (workspaces.has(scope.workspaceId) && (!scope.sessionId || sessions.has(scope.sessionId)))) continue;
      for (const tab of target.tabs.values()) remove(target, tab);
      states.delete(key);
      changed = true;
    }
    if (changed) render();
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
    for (const target of states.values()) for (const tab of target.tabs.values()) remove(target, tab);
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
          if (tab.type === type) remove(target, tab);
        }
        render();
      };
    },
    inspect(owner: string, title: string, node: HTMLElement) {
      const target = current;
      const identity = 'inspect:' + owner;
      const previous = target.tabs.get(identity);
      if (previous) remove(target, previous);
      const tab = add(target, identity, identity, title, () => node, true);
      return () => { remove(target, tab); if (target === current) render(); };
    }
  };
}
