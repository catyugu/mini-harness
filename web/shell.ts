import { element } from './api.js';
import type { Slot } from './extensions.js';
import { hydrateIcons } from './icons.js';

const slots: Record<Slot, string> = {
  sidebar: 'sidebarExtensions', composer: 'composerExtensions', settings: 'settingsExtensions',
  inspector: 'inspectorExtensions', approvals: 'approvalRequests',
  'session-navigation': 'navigationSlot', conversation: 'conversationSlot', dialogs: 'dialogSlot', main: 'mainSlot', 'conversation-header': 'conversationExtensions'
};

export function createShell() {
  const narrow = matchMedia('(max-width: 860px)');
  const sidebar = element('sidebar'), sidebarButton = element('sidebarOpen');
  const inspector = element('inspector'), inspectorButton = element('inspectorOpen');
  const inspectorContent = element('inspectorContent');
  const viewport = window.visualViewport;

  function setSidebar(open: boolean) {
    sidebar.classList.toggle('open', open && narrow.matches);
    sidebar.inert = narrow.matches && !open;
    element('app').classList.toggle('sidebar-collapsed', !open && !narrow.matches);
    element('overlay').hidden = !(open && narrow.matches);
    sidebarButton.setAttribute('aria-expanded', String(open));
  }

  function closeDrawer() { if (narrow.matches) setSidebar(false); }
  function setInspector(open: boolean) {
    inspector.hidden = !open;
    inspectorButton.setAttribute('aria-expanded', String(open));
  }

  sidebarButton.onclick = () => setSidebar(sidebarButton.getAttribute('aria-expanded') !== 'true');
  element('sidebarClose').onclick = element('overlay').onclick = () => { closeDrawer(); sidebarButton.focus(); };
  narrow.onchange = () => setSidebar(!narrow.matches);
  inspectorButton.onclick = () => setInspector(inspector.hidden);
  element('inspectorClose').onclick = () => setInspector(false);
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
    if (!inspector.hidden) { setInspector(false); inspectorButton.focus(); }
    else closeDrawer();
  });
  function resize() {
    document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
  }
  viewport?.addEventListener('resize', resize);
  resize();
  setSidebar(!narrow.matches);
  hydrateIcons();

  return {
    slot: (name: Slot) => element(slots[name]),
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
