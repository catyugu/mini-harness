import { scopedElements } from '../web/api.js';
import { fromMarkup } from '../ui-primitives/primitives.js';
import type { BrowserPlugin } from '../ui-runtime/frontend.js';
import { createLayout } from './layout.js';
import { createRightTabs } from './right-tabs.js';

/** App frame owns geometry and slot declarations, never feature navigation controls. */
declare module '../ui-slots/registry.js' {
  interface SlotMap {
    'sidebar.primary': { kind: 'list' };
    'sidebar.actions': { kind: 'list' };
    'sidebar.navigation': { kind: 'list' };
    'sidebar.footer': { kind: 'list' };
    'header.actions': { kind: 'list' };
    'conversation.header': { kind: 'list' };
    'conversation.body': { kind: 'single' };
    'inspector.extensions': { kind: 'list' };
    'dialog.root': { kind: 'list' };
  }
}

const slots = {
  'sidebar.primary': 'sidebarPrimary',
  'sidebar.actions': 'sidebarExtensions',
  'sidebar.navigation': 'navigationSlot',
  'sidebar.footer': 'sidebarFooter',
  'header.actions': 'headerActions',
  'conversation.header': 'conversationExtensions',
  'conversation.body': 'conversationSlot',
  'inspector.extensions': 'inspectorExtensions',
  'dialog.root': 'dialogSlot'
} as const;

export const layoutPlugin: BrowserPlugin = {
  id: 'core:layout',
  inject: ['miniState'],
  setup(ctx, api) {
    const { layout, pages, header, tabs, outlet } = createAppFrame(api.signal);
    ctx.provide('miniLayout', layout);
    ctx.provide('miniPages', pages);
    ctx.provide('miniHeader', header);
    ctx.provide('miniTabs', tabs);
    for (const name of Object.keys(slots) as Array<keyof typeof slots>)
      api.slots.define(name, outlet(name), name === 'conversation.body' ? 'single' : 'list');
    const state = ctx.miniState;
    state.on('navigation', () => {
      const { sessions, workspaces } = state.get();
      tabs.selectScope(state.scope());
      tabs.prune(new Set(sessions.map(({ id }) => id)), new Set(workspaces.map(({ id }) => id)));
    }, api.signal);
  }
};
export default layoutPlugin;

declare module 'cordis' {
  interface Context {
    miniLayout: ReturnType<typeof createAppFrame>['layout'];
    miniPages: ReturnType<typeof createAppFrame>['pages'];
    miniHeader: ReturnType<typeof createAppFrame>['header'];
  }
}

function createAppFrame(signal: AbortSignal) {
  const root = fromMarkup(`<div id="app" class="app">
  <aside id="sidebar" class="sidebar" aria-label="Conversations">
    <div class="sidebar-top">
      <div class="brand"><img src="/logo.svg" width="28" height="28" alt=""><span>mini-harness</span></div>
      <button id="sidebarClose" class="icon-button mobile-only" type="button" aria-label="Close navigation" data-icon="close"></button>
    </div>
    <div id="sidebarPrimary"></div>
    <div id="sidebarExtensions"></div>
    <div id="navigationSlot"></div>
    <div class="sidebar-bottom" id="sidebarFooter"></div>
  </aside>
  <button id="overlay" class="overlay" type="button" aria-label="Close navigation" tabindex="-1" hidden></button>
  <main class="main" id="main">
    <header class="topbar">
      <button id="sidebarOpen" class="icon-button" type="button" aria-label="Toggle navigation" aria-controls="sidebar" data-icon="menu"></button>
      <div class="title-block" id="titleBlock"><strong id="conversationTitle">New conversation</strong><div id="conversationExtensions"></div><div id="headerActions"></div></div>
      <button id="inspectorOpen" class="icon-button" type="button" aria-label="Open workspace panel" aria-controls="inspector" data-icon="files"></button>
    </header>
    <div id="conversationSlot"></div>
    <div id="mainSlot" hidden></div>
  </main>
  <aside id="inspector" class="right-panel" aria-label="Workspace panel" inert>
    <div id="panelResize" class="panel-resize" role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" aria-valuemin="260" tabindex="0"></div>
    <header>
      <div id="rightTabList" class="right-tab-list" role="tablist" aria-label="Workspace tabs"></div>
      <button id="inspectorClose" class="icon-button" type="button" aria-label="Close workspace panel" data-icon="close"></button>
    </header>
    <div id="inspectorExtensions"></div>
    <div id="inspectorContent" class="right-content"></div>
  </aside>
  <div id="dialogSlot"></div>
</div>`);
  document.body.append(root);
  signal.addEventListener('abort', () => root.remove(), { once: true });
  const { element } = scopedElements(root);
  const layout = createLayout({
    root, sidebar: element('sidebar'), sidebarButton: element('sidebarOpen'), sidebarClose: element('sidebarClose'),
    main: element('main'), overlay: element('overlay'), panel: element('inspector'),
    panelButton: element('inspectorOpen'), panelClose: element('inspectorClose'), resizeHandle: element('panelResize')
  }, signal);
  const tabs = createRightTabs({
    root: element('inspector'), bar: element('rightTabList'),
    body: element('inspectorContent'), toggle: element<'button'>('inspectorOpen')
  }, layout, signal);

  const pageViews = new Map<string, HTMLElement>();
  let selectedPage: string | undefined;
  function selectPage(id?: string) {
    if (id && !pageViews.has(id)) throw new Error('Unknown page: ' + id);
    selectedPage = id;
    element('conversationSlot').hidden = Boolean(id);
    element('titleBlock').hidden = Boolean(id);
    element('mainSlot').hidden = !id;
    for (const [key, view] of pageViews) view.hidden = key !== id;
    for (const entry of root.querySelectorAll<HTMLElement>('[data-page-link]')) {
      if (entry.dataset.pageLink === id) entry.setAttribute('aria-current', 'page');
      else entry.removeAttribute('aria-current');
    }
    if (id) { layout.setPanel(false); layout.closeDrawer(false); pageViews.get(id)?.focus(); }
  }
  const pages = {
    open: selectPage,
    register(id: string, node: HTMLElement) {
      if (pageViews.has(id)) throw new Error('Duplicate page: ' + id);
      pageViews.set(id, node);
      element('mainSlot').append(node);
      node.hidden = true;
      return () => {
        if (selectedPage === id) selectPage();
        pageViews.delete(id);
        node.remove();
      };
    }
  };
  const header = {
    setTitle: (title: string) => { element('conversationTitle').textContent = title; },
    placeWorkspace: (button: HTMLElement) => element('titleBlock').append(button)
  };
  const ui = {
    closeDrawer: layout.closeDrawer
  };
  return { layout: ui, header, pages, tabs, root, outlet: (name: keyof typeof slots) => element(slots[name]) };
}
