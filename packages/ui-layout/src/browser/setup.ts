import { fromMarkup, required, scopedElements } from '@mini-harness/ui-primitives/primitives';
import type { BrowserPrimitives } from '@mini-harness/ui-primitives/api';
import type { PageContribution } from './api.ts';
import type { Context } from 'mini-harness/cordis';
import { createLayout } from './layout.ts';
import { createRightTabs } from './right-tabs.ts';
import { createHeaderOutlet } from './header-overflow.ts';

/** App frame owns geometry and slot declarations, never feature navigation controls. */
const slots = {
  'sidebar.primary': 'sidebarPrimary',
  'sidebar.actions': 'sidebarExtensions',
  'sidebar.navigation': 'navigationSlot',
  'sidebar.footer': 'sidebarFooter',
  'header.actions': 'headerInline',
  'header.context': 'headerContext',
  'conversation.body': 'conversationSlot',
  'dialog.root': 'dialogSlot',
} as const;

const setup = (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const { layout, pages, header, tabs, dialogs, outlet } = createAppFrame(
    ctx.miniPrimitives,
    ctx.miniSlots,
    signal,
  );
  ctx.provide('miniLayout', layout);
  ctx.provide('miniPages', pages);
  ctx.provide('miniHeader', header);
  ctx.provide('miniTabs', tabs);
  ctx.provide('miniDialogs', dialogs);
  for (const name of Object.keys(slots) as Array<keyof typeof slots>)
    ctx.effect(() =>
      ctx.miniSlots.define(name, outlet(name), name === 'conversation.body' ? 'single' : 'list'),
    );
};
export default {
  inject: ['miniSlots', 'miniPrimitives'],
  provide: ['miniLayout', 'miniPages', 'miniHeader', 'miniTabs', 'miniDialogs'],
  apply: setup,
};

function createAppFrame(
  primitives: BrowserPrimitives,
  slotRegistry: Context['miniSlots'],
  signal: AbortSignal,
) {
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
      <div class="title-block" id="titleBlock"><strong id="conversationTitle">New conversation</strong><div class="header-meta" id="headerMeta"><div class="header-context" id="headerContext" hidden></div><div id="headerActions" hidden><div id="headerInline"></div><button id="headerMore" type="button" class="link-button" aria-label="More conversation controls" aria-expanded="false" aria-controls="headerOverflow" popovertarget="headerOverflow" data-icon="ellipsis" hidden></button><div id="headerOverflow" class="ui-popover" popover="auto" role="region" aria-label="More conversation controls"></div></div></div></div>
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
    <div id="inspectorContent" class="right-content"></div>
  </aside>
  <div id="dialogSlot"></div>
</div>`);
  document.body.append(root);
  signal.addEventListener('abort', () => root.remove(), { once: true });
  const { element } = scopedElements(root);
  const placeHeader = createHeaderOutlet(
    element('headerMeta'),
    element('headerContext'),
    element('headerActions'),
    element('headerInline'),
    element<'button'>('headerMore'),
    element('headerOverflow'),
    signal,
  );
  const layout = createLayout(
    {
      root,
      sidebar: element('sidebar'),
      sidebarButton: element('sidebarOpen'),
      sidebarClose: element('sidebarClose'),
      main: element('main'),
      overlay: element('overlay'),
      panel: element('inspector'),
      panelButton: element('inspectorOpen'),
      panelClose: element('inspectorClose'),
      resizeHandle: element('panelResize'),
    },
    signal,
  );
  const tabs = createRightTabs(
    {
      root: element('inspector'),
      bar: element('rightTabList'),
      body: element('inspectorContent'),
      toggle: element<'button'>('inspectorOpen'),
    },
    layout,
    signal,
  );

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
    if (id) {
      layout.setPanel(false);
      layout.closeDrawer(false);
      pageViews.get(id)?.focus();
    }
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
    },
    contribute(id: string, { title, content, order }: PageContribution, lifetime: AbortSignal) {
      const entry = primitives.button(title, 'quiet');
      entry.classList.add('nav-action');
      entry.dataset.pageLink = id;
      entry.addEventListener('click', () => selectPage(id), { signal: lifetime });
      const frame = fromMarkup(
        '<section class="plugin-page" tabindex="-1"><header><h1></h1></header><div class="plugin-page-body"></div></section>',
      );
      required(frame.querySelector('h1')).textContent = title;
      required(frame.querySelector('.plugin-page-body')).append(content);
      const unregister = pages.register(id, frame);
      try {
        const release = slotRegistry.register('sidebar.actions', entry, { order });
        return () => {
          try {
            release();
          } finally {
            unregister();
          }
        };
      } catch (error) {
        unregister();
        throw error;
      }
    },
  };
  const dialogs = {
    create(title: string, content: HTMLElement) {
      const node = primitives.dialog(title, content);
      const release = slotRegistry.register('dialog.root', node);
      return {
        node,
        dispose() {
          node.close();
          release();
        },
      };
    },
  };
  const header = {
    setTitle: (title: string) => {
      element('conversationTitle').textContent = title;
    },
    showContext: (show: boolean) => {
      element('headerContext').hidden = !show;
    },
  };
  const ui = {
    closeDrawer: layout.closeDrawer,
  };
  return {
    layout: ui,
    header,
    pages,
    tabs,
    dialogs,
    outlet: (name: keyof typeof slots) => (name === 'header.actions' ? placeHeader : element(slots[name])),
  };
}
