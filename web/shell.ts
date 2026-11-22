import { scopedElements } from './api.js';
import { fromMarkup } from './primitives.js';
import type { BrowserPlugin } from './extensions.js';
import { hydrateIcons } from './icons.js';
import { createLayout } from './layout.js';
import { createRightTabs } from './right-tabs.js';

const slots = {
  sidebar: 'sidebarExtensions', inspector: 'inspectorExtensions',
  'session-navigation': 'navigationSlot', conversation: 'conversationSlot', dialogs: 'dialogSlot', main: 'mainSlot', 'conversation-header': 'conversationExtensions'
};

export const shellPlugin: BrowserPlugin = {
  id: 'core:shell', inject: ['miniState'],
  setup(ctx, api) {
    const { shell, tabs } = createShell(api.signal);
    ctx.provide('miniShell', shell);
    ctx.provide('rightTabs', tabs);
    const { miniState: state } = ctx;
    state.on('navigation', () => {
      const { sessions, workspaces } = state.get();
      tabs.selectScope(state.scope());
      tabs.prune(new Set(sessions.map(({ id }) => id)), new Set(workspaces.map(({ id }) => id)));
    }, api.signal);
  }
};

declare module 'cordis' {
  interface Context { miniShell: ReturnType<typeof createShell>['shell']; rightTabs: ReturnType<typeof createRightTabs> }
}

function createShell(signal: AbortSignal) {
  const root = fromMarkup(`<div id="app" class="app">
  <aside id="sidebar" class="sidebar" aria-label="Conversations">
    <div class="sidebar-top">
      <div class="brand"><img src="/logo.svg" width="28" height="28" alt=""><span>mini-harness</span></div>
      <button id="sidebarClose" class="icon-button mobile-only" type="button" aria-label="Close navigation" data-icon="close"></button>
    </div>
    <button id="newSession" class="new-session" type="button" aria-label="New conversation"><span data-icon="plus"></span><span class="nav-label">New conversation</span></button>
    <div id="sidebarExtensions"></div>
    <div id="navigationSlot"></div>
    <div class="sidebar-bottom"><button id="settingsOpen" type="button" aria-label="Settings"><span data-icon="settings"></span><span class="nav-label">Settings</span></button></div>
  </aside>
  <button id="overlay" class="overlay" type="button" aria-label="Close navigation" tabindex="-1" hidden></button>
  <main class="main" id="main">
    <header class="topbar">
      <button id="sidebarOpen" class="icon-button" type="button" aria-label="Toggle navigation" aria-controls="sidebar" data-icon="menu"></button>
      <div class="title-block" id="titleBlock"><strong id="conversationTitle">New conversation</strong><div id="conversationExtensions"></div></div>
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
    <div id="rightTabLaunchers" class="right-tab-launchers"></div>
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
    root: element('inspector'), bar: element('rightTabList'), launchers: element('rightTabLaunchers'),
    body: element('inspectorContent'), toggle: element<'button'>('inspectorOpen')
  }, layout, signal);
  hydrateIcons();

  const shell = {
    outlet: (name: keyof typeof slots) => element(slots[name]),
    bindNew: (action: () => void, signal: AbortSignal) => element('newSession').addEventListener('click', action, { signal }),
    bindSettings: (action: () => void, signal: AbortSignal) => element('settingsOpen').addEventListener('click', action, { signal }),
    setTitle: (title: string) => { element('conversationTitle').textContent = title; },
    placeWorkspace: (button: HTMLElement) => element('titleBlock').append(button),
    closeDrawer: layout.closeDrawer,
    showPage(page?: HTMLElement) {
      element('conversationSlot').hidden = Boolean(page);
      for (const entry of element('sidebarExtensions').querySelectorAll<HTMLElement>('[aria-controls]')) {
        if (entry.getAttribute('aria-controls') === page?.id) entry.setAttribute('aria-current', 'page');
        else entry.removeAttribute('aria-current');
      }
      element('titleBlock').hidden = Boolean(page);
      element('mainSlot').hidden = !page;
      for (const child of element('mainSlot').children) (child as HTMLElement).hidden = child !== page;
      if (page) { layout.setPanel(false); layout.closeDrawer(false); page.focus(); }
    }
  };
  return { shell, tabs };
}
