import { button, iconButton } from '@mini-harness/ui-primitives/primitives';
import type { createLayout } from './layout.js';

import type { TabScope, TabAddress, RightTabType } from '@mini-harness/contracts/layout';

type Tab = {
  key: string;
  title: string;
  address?: TabAddress;
  view?: { node: HTMLElement; controller: AbortController };
};
type ScopeTabs = { scope?: TabScope; open: boolean; active?: Tab; tabs: Tab[] };
const scopeKey = (scope?: TabScope) => scope?.workspaceId ?? '';

export function createRightTabs(view: {
  root: HTMLElement; bar: HTMLElement; body: HTMLElement; toggle: HTMLButtonElement;
}, layout: ReturnType<typeof createLayout>, signal: AbortSignal) {
  const types = new Map<string, RightTabType>();
  const states = new Map<string, ScopeTabs>();
  let current = state();
  let nextId = 0;

  function state(scope?: TabScope): ScopeTabs {
    const key = scopeKey(scope);
    let selected = states.get(key);
    if (!selected) {
      selected = { scope, open: false, tabs: [] };
      states.set(key, selected);
    }
    return selected;
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
      select.onclick = () => activate(tab);
      const close = iconButton('Close tab ' + tab.title, 'close');
      close.onclick = () => { remove(current, tab); render(true); };
      item.append(select, close);
      return item;
    }));
    for (const tab of tabs) {
      const node = tab.view?.node ?? mount(tab, (signal) => {
        const address = tab.address;
        if (!address) throw new Error('Tab has no registered address');
        const factory = types.get(address.type);
        if (!factory) throw new Error('Tab type is not available: ' + address.type);
        return factory.create(address, signal);
      });
      node.hidden = tab !== active;
      if (node.parentElement !== view.body) view.body.append(node);
    }
    if (focus) (active ? document.getElementById(active.key + '-select') : view.root.querySelector<HTMLElement>('#inspectorClose'))?.focus();
  }

  function activate(tab: Tab) {
    current.active = tab;
    render(true);
    tab.view?.node.dispatchEvent(new Event('tab-activate'));
  }

  function selectScope(scope?: TabScope) {
    if (scopeKey(scope) === scopeKey(current.scope) && scope?.sessionId === current.scope?.sessionId) return;
    current.open = layout.panelOpen();
    // The frame can open before workspace selection and the default tab provider are ready.
    const openedBeforeSelection = !current.scope && Boolean(scope) && current.open;
    for (const tab of [...current.tabs]) {
      if (tab.address) unmount(tab);
      else remove(current, tab);
    }
    current = state(scope);
    current.scope = scope;
    if (openedBeforeSelection) current.open = true;
    for (const tab of current.tabs) if (tab.address) tab.address.sessionId = scope?.sessionId;
    render();
    layout.setPanel(current.open);
    if (openedBeforeSelection) openDefault();
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
    layout.closeDrawer(false);
    layout.setPanel(true, true);
    activate(tab);
  }

  function open(type: string, path?: string, scope = current.scope, mode?: string) {
    const definition = types.get(type);
    if (!definition || !scope) return;
    const target = state(scope);
    let tab = target.tabs.find(({ address }) => address?.type === type && address.path === path);
    if (!tab) {
      const address = { ...scope, type, path, mode };
      tab = { key: 'right-tab-' + ++nextId, title: definition.title(address), address };
      target.tabs.push(tab);
    }
    if (mode !== undefined && tab.address) tab.address.mode = mode;
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
      if (!scope) continue;
      if (workspaces.has(scope.workspaceId)) {
        if (target === current && scope.sessionId && !sessions.has(scope.sessionId)) selectScope({ workspaceId: scope.workspaceId });
        continue;
      }
      for (const tab of target.tabs) unmount(tab);
      states.delete(key);
      if (target === current) selectScope();
    }
  }

  function openDefault() {
    if (!current.scope || current.tabs.length) return false;
    const entry = [...types].find(([, type]) => type.default);
    if (!entry) return false;
    open(entry[0]);
    return true;
  }

  view.toggle.onclick = () => {
    if (!layout.panelOpen() && openDefault()) return;
    const opening = !layout.panelOpen();
    layout.setPanel(opening, true);
    if (opening) current.active?.view?.node.dispatchEvent(new Event('tab-activate'));
  };
  view.bar.addEventListener('keydown', (event) => {
    if (!(event.target as HTMLElement).matches('[role=tab]')) return;
    const { tabs } = current;
    if (!tabs.length) return;
    const index = current.active ? tabs.indexOf(current.active) : 0;
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length :
        event.key === 'ArrowRight' ? (index + 1) % tabs.length : undefined;
    if (target === undefined) return;
    event.preventDefault();
    activate(tabs[target]);
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
      // A plugin can register after a user has opened the empty right panel.
      // Materialize its default tab when the scope is already selected.
      if (definition.default && layout.panelOpen() && !current.tabs.length && current.scope)
        open(type);
      else render();
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
      const tab: Tab = { key, title };
      target.tabs.push(tab);
      mount(tab, () => node);
      if (!tab.view) throw new Error('Inspector tab failed to mount');
      const lifetime = tab.view.controller.signal;
      signal.addEventListener('abort', () => {
        remove(target, tab);
        if (target === current) render();
      }, { once: true, signal: lifetime });
      reveal(tab);
    }
  };
}
