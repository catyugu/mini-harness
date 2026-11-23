import { payload, scopedElements } from '@mini-harness/web/api';
import type { FrontendSetup, FrontendApi } from '@mini-harness/ui-runtime/frontend';
import { icon } from '@mini-harness/ui-primitives/icons';
import { closeOnBackdrop, field, fromMarkup, required, toggle } from '@mini-harness/ui-primitives/primitives';

const pageIcons = { General: 'settings', Model: 'model', Appearance: 'theme' } as const;

const setup: FrontendSetup = (ctx, api) => {
  const { miniLayout: layout, miniSettingsData: state } = ctx;
  const settings = mountSettings(api);
  ctx.provide('miniSettings', settings);
  ctx.provide('miniSettingsPages', { addPage: settings.addPage });
  api.slots.define('settings.extensions', settings.outlet);
  const launcher = fromMarkup<HTMLButtonElement>('<button type="button" aria-label="Settings"><span data-icon="settings"></span><span class="nav-label">Settings</span></button>');
  launcher.onclick = () => { layout.closeDrawer(); settings.open(); };
  api.slots.register('sidebar.footer', launcher);
  const general = fromMarkup('<div class="general-settings"><label class="switch-line"><span><strong>Add instructions</strong><small>When a response is running, queued messages steer the current task. Turn off to send them after the response as follow-ups.</small></span></label><p class="hint form-error" role="alert"></p></div>');
  const addInstructions = toggle('Add instructions', state.get().queueMode === 'steer');
  required(general.querySelector('.switch-line')).append(addInstructions);
  const generalStatus = required(general.querySelector<HTMLElement>('[role="alert"]'));
  const syncGeneral = () => { addInstructions.checked = state.get().queueMode === 'steer'; };
  state.subscribe(syncGeneral, api.signal);
  api.onDispose(settings.addPage('General', general, true));
  addInstructions.onchange = async () => {
    addInstructions.disabled = true;
    generalStatus.textContent = '';
    try {
      await api.request('/settings', payload('PATCH', { queueMode: addInstructions.checked ? 'steer' : 'followUp' }));
      await state.refresh();
    } catch (error) {
      generalStatus.textContent = error instanceof Error ? error.message : String(error);
      syncGeneral();
    } finally { addInstructions.disabled = false; }
  };
  const theme = fromMarkup<HTMLSelectElement>(`<select><option value="system">System</option>
    <option value="light">Light</option><option value="dark">Dark</option></select>`);
  const content = fromMarkup('<div class="appearance-settings"><p class="hint form-error" role="alert"></p></div>');
  const status = required(content.querySelector('[role="alert"]'));
  content.prepend(field('Theme', theme));
  function sync() { theme.value = state.get().appearance; }
  sync();
  state.subscribe(sync, api.signal);
  api.onDispose(settings.addPage('Appearance', content));
  theme.onchange = async () => {
    theme.disabled = true;
    status.textContent = '';
    try { await api.request('/settings', payload('PATCH', { appearance: theme.value })); await state.refresh(); }
    catch (error) { status.textContent = (error instanceof Error ? error.message : String(error)); sync(); }
    finally { theme.disabled = false; }
  };
};

function mountSettings(api: FrontendApi) {
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
  const pages = new Map<HTMLElement, HTMLButtonElement>();
  let selected: HTMLElement;

  function select(section?: HTMLElement, detail = true) {
    selected = section ?? [...sections.children].find((page) => !pages.get(page as HTMLElement)?.hidden) as HTMLElement;
    for (const [page, trigger] of pages) {
      page.hidden = page !== selected;
      if (page === selected) trigger.setAttribute('aria-current', 'page');
      else trigger.removeAttribute('aria-current');
    }
    body.classList.toggle('settings-detail', detail);
    sections.scrollTop = 0;
  }
  function addPage(title: string, content: HTMLElement, first = false) {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = title;
    section.append(heading, content);
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'link-button';
    trigger.append(icon(pageIcons[title as keyof typeof pageIcons] ?? 'plugin'), document.createTextNode(title));
    trigger.onclick = () => {
      select(section);
      if (matchMedia('(max-width: 560px)').matches) back.focus();
    };
    pages.set(section, trigger);
    if (first) { sections.prepend(section); nav.prepend(trigger); }
    else { sections.append(section); nav.append(trigger); }
    section.hidden = true;
    return {
      trigger,
      remove() {
        pages.delete(section);
        trigger.remove();
        section.remove();
        if (selected === section) select(undefined, false);
      }
    };
  }

  const outlet = document.createElement('div');
  const extensions = addPage('Extensions', outlet);
  function updateExtensions() {
    extensions.trigger.hidden = !outlet.childElementCount;
    if (extensions.trigger.hidden && pages.get(selected) === extensions.trigger) select(undefined, false);
  }
  const observer = new MutationObserver(updateExtensions);
  observer.observe(outlet, { childList: true });
  api.onDispose(() => observer.disconnect());
  updateExtensions();
  back.onclick = () => {
    body.classList.remove('settings-detail');
    pages.get(selected)?.focus();
  };
  return {
    outlet,
    open(detail = false) {
      select(undefined, detail);
      if (!panel.open) panel.showModal();
    },
    close: () => panel.close(),
    onClose: (listener: () => void, signal: AbortSignal) => panel.addEventListener('close', listener, { signal }),
    addPage: (title: string, content: HTMLElement, first?: boolean) => addPage(title, content, first).remove
  };
}

declare module 'cordis' {
  interface Context { miniSettings: ReturnType<typeof mountSettings> }
}

export default setup;
