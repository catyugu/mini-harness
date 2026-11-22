import type { Settings } from '../src/config.js';
import { payload, scopedElements } from './api.js';
import type { BrowserPlugin, FrontendApi } from './extensions.js';
import { icon } from './icons.js';
import { closeOnBackdrop, field, fromMarkup } from './primitives.js';

const pageIcons = { Model: 'model', Plugins: 'plugin', Appearance: 'theme' } as const;

export const settingsPlugin: BrowserPlugin = {
  id: 'core:settings', inject: ['miniState', 'miniShell', 'miniOutlets'],
  setup(ctx, api) {
    const { miniShell: shell, miniState: state } = ctx;
    const settings = mountSettings(api);
    ctx.miniOutlets.set('settings', settings.outlet);
    api.onDispose(() => { ctx.miniOutlets.delete('settings'); });
    ctx.provide('miniSettings', settings);
    shell.bindSettings(() => { shell.closeDrawer(); settings.open(); }, api.signal);
    const theme = fromMarkup<HTMLSelectElement>(`<select><option value="system">System</option>
      <option value="light">Light</option><option value="dark">Dark</option></select>`);
    const content = fromMarkup('<div class="appearance-settings"><p class="hint form-error" role="alert"></p></div>');
    const status = content.querySelector('[role="alert"]');
    content.prepend(field('Theme', theme));
    function sync() { theme.value = state.get().settings.appearance; }
    for (const [key, label] of [['body', 'Body text size'], ['code', 'Code size'], ['terminal', 'Terminal size']]) {
      const input = document.createElement('input');
      input.type = 'number'; input.min = '10'; input.max = '22'; input.step = '1';
      input.value = String(state.get().settings.typography[key]);
      input.onchange = async () => {
        input.disabled = true; status.textContent = '';
        try { state.apply(await api.request<Settings>('/settings', payload('PATCH', { typography: { [key]: Number(input.value) } }))); }
        catch (error) { status.textContent = error.message; }
        finally { input.value = String(state.get().settings.typography[key]); input.disabled = false; }
      };
      state.on('settings', () => { input.value = String(state.get().settings.typography[key]); }, api.signal);
      content.append(field(label, input));
    }
    for (const [key, label, choices] of [
      ['mini-harness-chat-mode', 'Chat detail', [['standard', 'Standard'], ['detailed', 'Detailed']]],
      ['mini-harness-collapse', 'Collapse process', [['completed', 'When completed'], ['next-turn', 'When the next turn starts'], ['never', 'Never']]]
    ] as const) {
      const select = document.createElement('select');
      select.append(...choices.map(([value, title]) => new Option(title, value)));
      select.value = localStorage.getItem(key) ?? choices[0][0];
      select.onchange = () => { localStorage.setItem(key, select.value); document.dispatchEvent(new Event('mini-harness-presentation')); };
      content.append(field(label, select));
    }
    const execution = fromMarkup('<div><p class="hint">Default permission applies to future conversations. Change the active conversation in its composer.</p><p role="status" class="hint"></p></div>');
    const permission = document.createElement('select');
    permission.append(new Option('View only', 'read-only'), new Option('Workspace modifications', 'workspace-write'), new Option('Full access', 'full'));
    const syncPermission = () => { permission.value = state.get().settings.defaultPermission; };
    syncPermission(); state.on('settings', syncPermission, api.signal);
    execution.prepend(field('Default execution permission', permission));
    api.settingsPage('Execution', execution);
    permission.onchange = async () => {
      const next = permission.value; syncPermission();
      if (next === 'full' && !confirm('Use full user permissions for future conversations?')) return;
      permission.disabled = true;
      try { state.apply(await api.request<Settings>('/settings', payload('PATCH', { defaultPermission: next, confirmed: next === 'full' }))); }
      catch (error) { execution.querySelector('[role="status"]').textContent = error.message; }
      finally { syncPermission(); permission.disabled = false; }
    };
    sync();
    state.on('settings', sync, api.signal);
    api.onDispose(settings.addPage('Appearance', content));
    theme.onchange = async () => {
      theme.disabled = true;
      status.textContent = '';
      try { state.apply(await api.request<Settings>('/settings', payload('PATCH', { appearance: theme.value }))); }
      catch (error) { status.textContent = error.message; sync(); }
      finally { theme.disabled = false; }
    };
  }
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
  const nav = panel.querySelector<HTMLElement>('nav');
  const sections = panel.querySelector<HTMLElement>('.settings-sections');
  const body = panel.querySelector<HTMLElement>('.settings-body');
  const back = element<'button'>('settingsBack');
  const close = element<'button'>('settingsClose');
  close.append(icon('close'));
  close.onclick = () => panel.close();
  back.prepend(icon('chevron'));
  api.mount('dialogs', panel);
  closeOnBackdrop(panel);
  const pages = new Map<HTMLElement, HTMLButtonElement>();
  let selected: HTMLElement;

  function select(section?: HTMLElement, detail = true) {
    selected = section ?? [...sections.children].find((page) => !pages.get(page as HTMLElement).hidden) as HTMLElement;
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
    trigger.append(icon(pageIcons[title] ?? 'plugin'), document.createTextNode(title));
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
