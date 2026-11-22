import { button, iconButton } from './primitives.js';
import type { createLayout } from './layout.js';

export interface TabScope { workspaceId: string; sessionId?: string }
export interface TabAddress extends TabScope { type: string; path?: string; line?: number }
export interface RightTabType {
  title(address: TabAddress): string;
  create(address: TabAddress, signal: AbortSignal): HTMLElement;
  launcher?: string;
  default?: boolean;
  canOpen?(address: TabAddress): boolean;
}

type Tab = {
  key: string;
  address?: TabAddress;
  inspector?: { title: string; node: HTMLElement };
};
type ScopeTabs = { scope?: TabScope; open: boolean; active?: string; tabs: Map<string, Tab> };
const scopeKey = (scope?: TabScope) => JSON.stringify([scope?.workspaceId, scope?.sessionId]);
const identity = ({ type, path }: TabAddress) => JSON.stringify([type, path ?? '']);
const storageKey = (scope?: TabScope) => 'mini-harness-tabs:' + scopeKey(scope);

export function createRightTabs(view: {
  root: HTMLElement; bar: HTMLElement; launchers: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement;
}, layout: ReturnType<typeof createLayout>, signal: AbortSignal) {
  const types = new Map<string, RightTabType>();
  const states = new Map<string, ScopeTabs>();
  let nextId = 0;
  let current = state();
  let mounted: { tab: Tab; node: HTMLElement; controller: AbortController } | undefined;

  function state(scope?: TabScope): ScopeTabs {
    const key = scopeKey(scope);
    const existing = states.get(key);
    if (existing) return existing;
    const target: ScopeTabs = { scope, open: false, tabs: new Map() };
    if (scope) {
      let saved: { open?: boolean; entries?: TabAddress[]; active?: string };
      try { saved = JSON.parse(sessionStorage.getItem(storageKey(scope))); } catch { /* Discard invalid browser state. */ }
      for (const address of Array.isArray(saved?.entries) ? saved.entries : []) {
        if (typeof address?.type !== 'string' || address.workspaceId !== scope.workspaceId || address.sessionId !== scope.sessionId ||
          (address.path !== undefined && typeof address.path !== 'string')) continue;
        target.tabs.set(identity(address), { key: 'right-tab-' + ++nextId, address });
      }
      target.open = saved?.open === true;
      if (target.tabs.has(saved?.active)) target.active = saved.active;
    }
    states.set(key, target);
    return target;
  }

  function persist(target = current) {
    if (!target.scope) return;
    sessionStorage.setItem(storageKey(target.scope), JSON.stringify({
      open: target.open, entries: [...target.tabs.values()].flatMap(({ address }) => address ? [address] : []),
      active: target.tabs.get(target.active)?.address ? target.active : undefined
    }));
  }

  function available(target: ScopeTabs) {
    return [...target.tabs].filter(([, { address }]) => {
      if (!address) return true;
      const definition = types.get(address.type);
      return definition && (!definition.canOpen || definition.canOpen(address));
    });
  }

  function unmount() {
    const previous = mounted;
    mounted = undefined;
    previous?.controller.abort();
    previous?.node.remove();
  }

  function mount(tab: Tab) {
    const controller = new AbortController();
    try {
      const node = tab.inspector?.node ?? types.get(tab.address.type).create(tab.address, controller.signal);
      node.id = tab.key;
      node.setAttribute('role', 'tabpanel');
      node.setAttribute('aria-labelledby', tab.key + '-select');
      node.classList.add('right-tab-content');
      view.body.append(node);
      mounted = { tab, node, controller };
    } catch (error) {
      controller.abort();
      throw error;
    }
  }

  function render(focus = false) {
    const entries = available(current);
    const selected = entries.find(([id]) => id === current.active) ?? entries[0];
    const active = selected?.[1];
    const focused = view.bar.contains(document.activeElement);
    view.bar.replaceChildren(...entries.map(([id, tab]) => {
      const item = document.createElement('div');
      item.className = 'right-tab';
      const title = tab.inspector?.title ?? types.get(tab.address.type).title(tab.address);
      const select = button(title, 'quiet');
      select.id = tab.key + '-select';
      select.title = tab.address?.path ?? title;
      select.setAttribute('role', 'tab');
      select.setAttribute('aria-selected', String(tab === active));
      select.setAttribute('aria-controls', tab.key);
      select.tabIndex = tab === active ? 0 : -1;
      select.onclick = () => { current.active = id; render(true); };
      const close = iconButton('Close tab ' + title, 'close');
      close.onclick = () => { remove(current, id, tab); render(true); };
      item.append(select, close);
      return item;
    }));
    const visible = current.open ? active : undefined;
    if (mounted?.tab !== visible) {
      unmount();
      if (visible) mount(visible);
    }
    view.launchers.replaceChildren(...[...types].flatMap(([id, type]) => {
      if (!current.scope || !type.launcher || (type.canOpen && !type.canOpen({ ...current.scope, type: id }))) return [];
      const control = button(type.launcher, 'quiet');
      control.onclick = () => open(id);
      return [control];
    }));
    persist();
    if ((focus || focused) && current.open)
      (active ? document.getElementById(active.key + '-select') : view.root.querySelector<HTMLElement>('#inspectorClose'))?.focus();
  }

  function selectScope(scope?: TabScope) {
    if (scopeKey(scope) === scopeKey(current.scope)) return;
    unmount();
    current = state(scope);
    if (layout.panelOpen() === current.open) render();
    else layout.setPanel(current.open);
  }

  function open(type: string, path?: string, scope = current.scope, line?: number) {
    const definition = types.get(type);
    if (!definition || !scope) return;
    const address = { workspaceId: scope.workspaceId, sessionId: scope.sessionId, type, path, line };
    if (definition.canOpen && !definition.canOpen(address)) return;
    const target = state(scope);
    const id = identity(address);
    const tab = target.tabs.get(id);
    if (tab) {
      tab.address.line = line;
      if (mounted?.tab === tab) mounted.node.dispatchEvent(new CustomEvent('navigate-resource', { detail: tab.address }));
    } else target.tabs.set(id, { key: 'right-tab-' + ++nextId, address });
    target.active = id;
    target.open = true;
    if (target === current) {
      layout.setPanel(true, true);
      render(true);
    } else persist(target);
  }

  function remove(target: ScopeTabs, id: string, tab: Tab) {
    if (target.tabs.get(id) !== tab) return;
    const entries = available(target);
    const index = entries.findIndex(([key]) => key === id);
    target.tabs.delete(id);
    if (mounted?.tab === tab) unmount();
    if (target.active === id) target.active = (entries[index + 1] ?? entries[index - 1])?.[0];
  }

  function prune(sessions: ReadonlySet<string>, workspaces: ReadonlySet<string>) {
    for (const [key, target] of states) {
      const scope = target.scope;
      if (!scope || (workspaces.has(scope.workspaceId) && (!scope.sessionId || sessions.has(scope.sessionId)))) continue;
      states.delete(key);
      sessionStorage.removeItem(storageKey(scope));
      if (target === current) selectScope();
    }
  }

  view.root.addEventListener('panel-change', (event: CustomEvent<boolean>) => {
    current.open = event.detail;
    render();
  }, { signal });
  view.toggle.onclick = () => {
    if (!layout.panelOpen() && !available(current).length && current.scope) {
      const entry = [...types].find(([id, type]) => type.default && (!type.canOpen || type.canOpen({ ...current.scope, type: id })));
      if (entry) { open(entry[0]); return; }
    }
    layout.setPanel(!layout.panelOpen(), true);
  };
  view.bar.addEventListener('keydown', (event) => {
    if (!(event.target as HTMLElement).matches('[role=tab]')) return;
    const tabs = available(current);
    const index = tabs.findIndex(([, tab]) => tab.key + '-select' === (event.target as HTMLElement).id);
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      event.key === 'ArrowLeft' ? (Math.max(0, index) + tabs.length - 1) % tabs.length :
        event.key === 'ArrowRight' ? (Math.max(0, index) + 1) % tabs.length : undefined;
    if (target === undefined) return;
    event.preventDefault();
    current.active = tabs[target][0];
    render(true);
  }, { signal });
  signal.addEventListener('abort', () => {
    unmount();
    states.clear();
  }, { once: true });

  return {
    selectScope, open, prune,
    navigate(resource: { path: string; kind?: 'file' | 'diff'; line?: number }, scope = current.scope) {
      const path = resource.path.replaceAll('\\', '/').replace(/^\.\//, '');
      open(resource.kind === 'diff' ? 'files:diff' : 'files:preview', path, scope, resource.line);
    },
    register(type: string, definition: RightTabType) {
      if (typeof definition?.create !== 'function' || typeof definition.title !== 'function') throw new Error('Tab types require title and create functions');
      if (types.has(type)) throw new Error('Duplicate right panel tab type: ' + type);
      types.set(type, definition);
      render();
      return () => {
        if (types.get(type) !== definition) return;
        types.delete(type);
        render();
      };
    },
    inspect(owner: string, title: string, node: HTMLElement) {
      const target = current;
      const id = 'inspect:' + owner;
      const previous = target.tabs.get(id);
      if (previous) remove(target, id, previous);
      const tab: Tab = { key: 'right-tab-' + ++nextId, inspector: { title, node } };
      target.tabs.set(id, tab);
      target.active = id;
      layout.closeDrawer(false);
      layout.setPanel(true, true);
      render(true);
      return () => { remove(target, id, tab); if (target === current) render(); };
    }
  };
}
