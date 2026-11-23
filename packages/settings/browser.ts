import { scopedElements } from '@mini-harness/web/api';
import type { FrontendSetup, FrontendApi } from '@mini-harness/ui-runtime/frontend';
import { icon } from '@mini-harness/ui-primitives/icons';
import { closeOnBackdrop, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';

const setup: FrontendSetup = (ctx, api) => {
  const { miniLayout: layout, miniSettingsRegistry: registry } = ctx;
  const settings = mountSettings(api, registry);
  ctx.provide('miniSettings', settings);
  const launcher = fromMarkup<HTMLButtonElement>('<button type="button" aria-label="Settings"><span data-icon="settings"></span><span class="nav-label">Settings</span></button>');
  launcher.onclick = () => { layout.closeDrawer(); settings.open(); };
  api.slots.register('sidebar.footer', launcher);
};

function mountSettings(api: FrontendApi, registry: import('cordis').Context['miniSettingsRegistry']) {
  const panel = fromMarkup<HTMLDialogElement>(`<dialog id="settingsPanel" class="settings-panel" aria-labelledby="settingsTitle">
    <header class="settings-header">
      <h2 id="settingsTitle">Settings</h2>
      <button id="settingsClose" class="icon-button" type="button" aria-label="Close settings"></button>
    </header>
    <div class="settings-body">
      <nav class="settings-nav" aria-label="Settings sections"></nav>
      <div class="settings-content">
        <button id="settingsBack" type="button" class="link-button settings-back">All settings</button>
        <div class="settings-scroll settings-sections"></div>
      </div>
    </div>
  </dialog>`);
  const { element } = scopedElements(panel);
  const nav = required(panel.querySelector<HTMLElement>('nav'));
  const sections = required(panel.querySelector<HTMLElement>('.settings-sections'));
  const body = required(panel.querySelector<HTMLElement>('.settings-body'));
  const back = element<'button'>('settingsBack');
  const close = element<'button'>('settingsClose');
  close.append(icon('close'));
  close.onclick = () => panel.close();
  back.prepend(icon('chevron'));
  api.slots.register('dialog.root', panel);
  closeOnBackdrop(panel);
  const pages = new Map<string, { section: HTMLElement; trigger: HTMLButtonElement; content: HTMLElement }>();
  let selected: string | undefined;

  function select(title?: string, detail = false) {
    selected = title && pages.has(title) ? title : nav.querySelector('button')?.dataset.section;
    for (const [name, { section, trigger }] of pages) {
      section.hidden = name !== selected;
      if (name === selected) trigger.setAttribute('aria-current', 'page');
      else trigger.removeAttribute('aria-current');
    }
    body.classList.toggle('settings-detail', detail);
    sections.scrollTop = 0;
  }

  function render() {
    const groups = registry.sections();
    const titles = new Set(groups.map(({ section }) => section.title));
    for (const [title, { section, trigger }] of pages) {
      if (titles.has(title)) continue;
      section.remove();
      trigger.remove();
      pages.delete(title);
    }
    groups.forEach(({ section: { title, icon: symbol }, nodes }, index) => {
      let page = pages.get(title);
      if (!page) {
        const section = document.createElement('section');
        section.hidden = true;
        const heading = document.createElement('h3');
        heading.textContent = title;
        const content = document.createElement('div');
        content.className = 'settings-contributions';
        section.append(heading, content);
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'link-button';
        trigger.dataset.section = title;
        trigger.onclick = () => {
          select(title, true);
          if (matchMedia('(max-width: 560px)').matches) back.focus();
        };
        page = { section, trigger, content };
        pages.set(title, page);
      }
      const { section, trigger, content } = page;
      const nextSymbol = JSON.stringify(symbol);
      if (!trigger.childElementCount || trigger.dataset.symbol !== nextSymbol) {
        trigger.replaceChildren(icon(symbol ?? 'plugin'), document.createTextNode(title));
        if (nextSymbol === undefined) delete trigger.dataset.symbol;
        else trigger.dataset.symbol = nextSymbol;
      }
      if (sections.children[index] !== section) sections.insertBefore(section, sections.children[index] ?? null);
      if (nav.children[index] !== trigger) nav.insertBefore(trigger, nav.children[index] ?? null);
      const desired = new Set(nodes);
      for (const node of [...content.children]) if (!desired.has(node as HTMLElement)) node.remove();
      nodes.forEach((node, position) => {
        if (content.children[position] !== node) content.insertBefore(node, content.children[position] ?? null);
      });
    });
    if (selected === undefined || !pages.has(selected)) select();
  }

  registry.addEventListener('change', render, { signal: api.signal });
  render();
  back.onclick = () => {
    body.classList.remove('settings-detail');
    if (selected) pages.get(selected)?.trigger.focus();
  };
  return {
    open(title?: string) {
      select(title, Boolean(title));
      if (!panel.open) panel.showModal();
    },
    onClose: (listener: () => void, signal: AbortSignal) => panel.addEventListener('close', listener, { signal }),
  };
}

declare module 'cordis' {
  interface Context { miniSettings: ReturnType<typeof mountSettings> }
}

export default setup;
