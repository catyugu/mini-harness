import { scopedElements } from './api.js';
import { fromMarkup } from './primitives.js';
import type { BrowserPlugin } from './extensions.js';
import type { Slot } from './extensions.js';
import { hydrateIcons } from './icons.js';

const slots: Partial<Record<Slot, string>> = {
  sidebar: 'sidebarExtensions', inspector: 'inspectorExtensions',
  'session-navigation': 'navigationSlot', conversation: 'conversationSlot', dialogs: 'dialogSlot', main: 'mainSlot', 'conversation-header': 'conversationExtensions'
};

export const shellPlugin: BrowserPlugin = {
  id: 'core:shell',
  setup(ctx, api) {
    ctx.provide('miniShell', createShell(api.signal));
  }
};

declare module 'cordis' {
  interface Context { miniShell: ReturnType<typeof createShell> }
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
  <main class="main">
    <header class="topbar">
      <button id="sidebarOpen" class="icon-button" type="button" aria-label="Toggle navigation" aria-controls="sidebar" data-icon="menu"></button>
      <div class="title-block" id="titleBlock"><strong id="conversationTitle">New conversation</strong><div id="conversationExtensions"></div></div>
      <button id="inspectorOpen" class="icon-button" type="button" aria-label="Open inspector" data-icon="files"></button>
    </header>
    <div id="conversationSlot"></div>
    <div id="mainSlot" hidden></div>
  </main>
  <aside id="inspector" class="inspector" aria-label="Inspector" hidden>
    <header><strong id="inspectorTitle">Workspace</strong><button id="inspectorClose" class="icon-button" type="button" aria-label="Close inspector" data-icon="close"></button></header>
    <div id="inspectorExtensions"></div><div id="inspectorContent" class="inspector-content"></div>
  </aside>
  <div id="dialogSlot"></div>
</div>`);
  document.body.append(root);
  signal.addEventListener('abort', () => root.remove(), { once: true });
  const { element } = scopedElements(root);
  const narrow = matchMedia('(max-width: 860px)');
  const sidebar = element('sidebar'), sidebarButton = element('sidebarOpen');
  const inspector = element('inspector'), inspectorButton = element('inspectorOpen');
  const inspectorContent = element('inspectorContent');
  let inspectorTrigger: HTMLElement;
  const viewport = window.visualViewport;

  function setSidebar(open: boolean) {
    sidebar.classList.toggle('open', open && narrow.matches);
    sidebar.inert = narrow.matches && !open;
    root.classList.toggle('sidebar-collapsed', !open && !narrow.matches);
    element('overlay').hidden = !(open && narrow.matches);
    sidebarButton.setAttribute('aria-expanded', String(open));
  }

  function closeDrawer() { if (narrow.matches) setSidebar(false); }
  function setInspector(open: boolean) {
    inspector.hidden = !open;
    inspectorButton.setAttribute('aria-expanded', String(open));
    if (!open && inspectorTrigger?.isConnected && !inspectorTrigger.closest('[inert]')) inspectorTrigger.focus();
  }

  sidebarButton.onclick = () => setSidebar(sidebarButton.getAttribute('aria-expanded') !== 'true');
  element('sidebarClose').onclick = element('overlay').onclick = () => { closeDrawer(); sidebarButton.focus(); };
  narrow.addEventListener('change', () => setSidebar(!narrow.matches), { signal });
  inspectorButton.onclick = () => { inspectorTrigger = inspectorButton; setInspector(inspector.hidden); };
  element('inspectorClose').onclick = () => setInspector(false);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (!inspector.hidden) setInspector(false);
    else closeDrawer();
  }, { signal });
  function resize() {
    document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
  }
  viewport?.addEventListener('resize', resize, { signal });
  resize();
  setSidebar(!narrow.matches);
  inspectorButton.setAttribute('aria-expanded', 'false');
  inspectorButton.setAttribute('aria-controls', inspector.id);
  hydrateIcons();

  return {
    slot: (name: Slot) => slots[name] ? element(slots[name]) : null,
    bindNew: (action: () => void, signal: AbortSignal) => element('newSession').addEventListener('click', action, { signal }),
    bindSettings: (action: () => void, signal: AbortSignal) => element('settingsOpen').addEventListener('click', action, { signal }),
    setTitle: (title: string) => { element('conversationTitle').textContent = title; },
    placeWorkspace: (button: HTMLElement) => element('titleBlock').append(button),
    closeDrawer,
    showPage(page?: HTMLElement) {
      element('conversationSlot').hidden = Boolean(page);
      for (const entry of element('sidebarExtensions').querySelectorAll<HTMLElement>('[aria-controls]')) {
        if (entry.getAttribute('aria-controls') === page?.id) entry.setAttribute('aria-current', 'page');
        else entry.removeAttribute('aria-current');
      }
      element('titleBlock').hidden = Boolean(page);
      element('mainSlot').hidden = !page;
      for (const child of element('mainSlot').children) (child as HTMLElement).hidden = child !== page;
      if (page) { setInspector(false); closeDrawer(); page.focus(); }
    },
    inspect(title: string, content: HTMLElement) {
      if (inspector.hidden || !inspector.contains(document.activeElement)) inspectorTrigger = document.activeElement as HTMLElement;
      element('inspectorTitle').textContent = title;
      inspectorContent.replaceChildren(content);
      setInspector(true);
      return () => {
        if (content.parentElement !== inspectorContent) return;
        content.remove();
        setInspector(false);
      };
    }
  };
}
