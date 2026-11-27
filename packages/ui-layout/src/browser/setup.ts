import { fromMarkup, required, scopedElements } from '@mini-harness/ui-primitives/primitives';
import type { BrowserPrimitives } from '@mini-harness/ui-primitives/api';
import type { PageContribution } from './api.ts';
import type { Context } from 'mini-harness/cordis';
import { createLayout } from './layout.ts';
import { createRightTabs } from './right-tabs.ts';

/** App frame owns geometry and slot declarations, never feature navigation controls. */
const slots = {
  'sidebar.primary': 'sidebarPrimary',
  'sidebar.actions': 'sidebarExtensions',
  'sidebar.navigation': 'navigationSlot',
  'sidebar.footer': 'sidebarFooter',
  'header.actions': 'headerActions',
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
    <div id="sidebarResize" class="panel-resize" role="separator" aria-label="Resize navigation sidebar" aria-orientation="vertical" aria-controls="sidebar" tabindex="0"></div>
    <div class="sidebar-top">
      <div class="brand"><img src="/logo.svg" width="28" height="28" alt=""><span>mini-harness</span></div>
      <button id="sidebarClose" class="icon-button" hidden type="button" aria-label="Close navigation" data-icon="close"></button>
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
      <div class="title-block" id="titleBlock"><strong id="conversationTitle">New conversation</strong><div class="header-meta" id="headerMeta"><div class="header-context" id="headerContext"></div><div id="headerActions"></div></div></div>
      <button id="inspectorOpen" class="icon-button" type="button" aria-label="Open workspace panel" aria-controls="inspector" data-icon="panel-right"></button>
    </header>
    <div id="conversationSlot"></div>
    <div id="mainSlot" hidden></div>
  </main>
  <aside id="inspector" class="right-panel" aria-label="Workspace panel" inert>
    <div id="panelResize" class="panel-resize" role="separator" aria-label="Resize workspace panel" aria-orientation="vertical" aria-controls="inspector" tabindex="0"></div>
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
  const meta = element('headerMeta');
  const context = element('headerContext');
  const placeHeader = primitives.overflowActions(
    element('headerActions'),
    'More conversation controls',
    signal,
    meta,
    () =>
      meta.clientWidth -
      (context.querySelector(':scope > :not([hidden])')
        ? Math.min(64, meta.clientWidth * 0.3) + (parseFloat(getComputedStyle(meta).gap) || 0)
        : 0),
  );
  const tabs = createRightTabs(
    {
      root: element('inspector'),
      bar: element('rightTabList'),
      body: element('inspectorContent'),
      toggle: element<'button'>('inspectorOpen'),
    },
    (focus) => layout.panelChanged(focus),
    signal,
  );
  const layout = createLayout(
    {
      root,
      sidebar: element('sidebar'),
      sidebarButton: element('sidebarOpen'),
      sidebarClose: element('sidebarClose'),
      sidebarResize: element('sidebarResize'),
      main: element('main'),
      overlay: element('overlay'),
      panel: element('inspector'),
      panelButton: element('inspectorOpen'),
      panelClose: element('inspectorClose'),
      panelResize: element('panelResize'),
    },
    signal,
    tabs,
  );

  const pageViews = new Map<string, { view: HTMLElement; trigger?: HTMLButtonElement }>();
  let selectedPage: string | undefined;
  function selectPage(id?: string) {
    if (id && !pageViews.has(id)) throw new Error('Unknown page: ' + id);
    selectedPage = id;
    element('conversationSlot').hidden = Boolean(id);
    element('titleBlock').hidden = Boolean(id);
    element('mainSlot').hidden = !id;
    for (const [key, { view, trigger }] of pageViews) {
      view.hidden = key !== id;
      if (key === id) trigger?.setAttribute('aria-current', 'page');
      else trigger?.removeAttribute('aria-current');
    }
    if (id) {
      tabs.setPanel(false);
      layout.closeDrawer(false);
      pageViews.get(id)?.view.focus();
    }
  }
  const pages = {
    open: selectPage,
    register(id: string, node: HTMLElement, trigger?: HTMLButtonElement) {
      if (pageViews.has(id)) throw new Error('Duplicate page: ' + id);
      pageViews.set(id, { view: node, trigger });
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
      entry.classList.add('ui-nav-action', 'ui-truncate');
      entry.title = title;
      entry.addEventListener('click', () => selectPage(id), { signal: lifetime });
      const frame = fromMarkup(
        '<section class="plugin-page" tabindex="-1"><header><h1></h1></header><div class="plugin-page-body"></div></section>',
      );
      required(frame.querySelector('h1')).textContent = title;
      required(frame.querySelector('.plugin-page-body')).append(content);
      const unregister = pages.register(id, frame, entry);
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
