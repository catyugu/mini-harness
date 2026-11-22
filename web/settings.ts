import type { Settings } from '../src/config.js';
import type { Bootstrap } from './types.js';
import { scopedElements, data, payload } from './api.js';
import { closeOnBackdrop, fromMarkup } from './primitives.js';
import { icon } from './icons.js';
import type { FrontendApi } from './extensions.js';
import { schemaFields, readPluginValues } from './settings-fields.js';
export function mountSettings(api: FrontendApi) {
  const panel = fromMarkup<HTMLDialogElement>(`
  <dialog id="settingsPanel" class="settings-panel" aria-labelledby="settingsTitle">
    <div class="settings-header">
      <h2 id="settingsTitle">Settings</h2>
      <button id="settingsClose" class="icon-button" type="button" aria-label="Close settings" data-icon="close"></button>
    </div>
    <div id="settingsBody" class="settings-body">
      <nav id="settingsNav" class="settings-nav" aria-label="Settings sections"></nav>
      <div id="settingsForm">
        <button id="settingsBack" class="link-button settings-back" type="button">← All settings</button>
        <div id="settingsSections" class="settings-scroll">
          <section>
            <h3>Agent</h3>
            <div class="setting-columns">
              <div><label for="maxDepth">Maximum child depth</label><input id="maxDepth" type="number" min="0" max="8" required></div>
              <div><label for="maxParallel">Parallel children</label><input id="maxParallel" type="number" min="1" max="16" required></div>
            </div>
            <label for="childProvider">Child provider</label><input id="childProvider" placeholder="Inherit parent">
            <label for="childModel">Child model</label><input id="childModel" placeholder="Inherit parent">
          </section>
          <section><h3>Plugins</h3><div id="pluginSettings"></div><div id="installPluginSettings"></div></section>
          <section>
            <h3>Appearance</h3>
            <label for="theme">Theme</label>
            <select id="theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
          </section>
          <section>
            <h3>Execution policy</h3>
            <p id="isolationStatus" class="hint"></p>
            <label for="sandboxMode">Shell policy</label>
            <select id="sandboxMode"><option value="isolated">Isolated (Linux)</option><option value="host">Trusted host</option></select>
            <label for="timeout">Timeout (seconds)</label><input id="timeout" type="number" min="1" max="300" required>
          </section>
          <section id="extensionSettings" hidden><h3>Extensions</h3><div id="settingsExtensions"></div></section>
        </div>
        <footer class="settings-footer">
          <p id="settingsStatus" class="hint" role="status"></p>
          <button id="saveSettings" class="primary" type="button">Save settings</button>
        </footer>
      </div>
    </div>
  </dialog>`);
  api.mount('dialogs', panel);
  closeOnBackdrop(panel);
  return { panel, ...createSettingsNavigation(api, panel) };
}

function createSettingsNavigation(api: FrontendApi, panel: HTMLDialogElement) {
  const { element } = scopedElements(panel);
  const body = element('settingsBody'), nav = element('settingsNav');
  const sections = element('settingsSections');
  const legacy = element('extensionSettings');
  const navButtons = new Map<HTMLElement, HTMLButtonElement>();
  let selected: HTMLElement;

  function show(section: HTMLElement, enter = true) {
    selected = section;
    for (const [page, button] of navButtons) {
      page.hidden = page !== selected;
      button.setAttribute('aria-current', page === selected ? 'page' : 'false');
    }
    body.classList.toggle('settings-detail', enter);
    sections.scrollTop = 0;
    element('saveSettings').hidden = section.dataset.ownForm === 'true';
  }

  const pageIcons = { Model: 'model', Agent: 'skills', Plugins: 'plugin', Appearance: 'theme', 'Execution policy': 'terminal' } as const;
  function add(section: HTMLElement, title: string, first = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.append(icon(pageIcons[title] ?? 'plugin'), document.createTextNode(title));
    button.onclick = () => {
      show(section);
      if (matchMedia('(max-width: 560px)').matches) element('settingsBack').focus();
    };
    if (first) nav.prepend(button);
    else nav.append(button);
    navButtons.set(section, button);
    section.hidden = true;
    return () => {
      if (selected === section) show(sections.querySelector('section'), false);
      navButtons.delete(section);
      button.remove();
      section.remove();
    };
  }

  for (const section of sections.querySelectorAll<HTMLElement>(':scope > section')) {
    add(section, section.querySelector('h3').textContent);
  }
  const legacyButton = navButtons.get(legacy);
  const updateLegacy = () => {
    legacyButton.hidden = !element('settingsExtensions').childElementCount;
    if (legacyButton.hidden && selected === legacy) show(sections.querySelector('section'), false);
  };
  const observer = new MutationObserver(updateLegacy);
  observer.observe(element('settingsExtensions'), { childList: true });
  api.onDispose(() => observer.disconnect());
  updateLegacy();
  show(sections.querySelector('section'), false);

  element('settingsBack').onclick = () => {
    body.classList.remove('settings-detail');
    navButtons.get(selected)?.focus();
  };
  return {
    outlet: element('settingsExtensions'),
    open(detail = false) {
      show(sections.querySelector('section'), detail);
      panel.showModal();
    },
    addPage(title: string, content: HTMLElement, first = false) {
      const section = document.createElement('section'), heading = document.createElement('h3');
      heading.textContent = title;
      section.append(heading, content);
      section.dataset.ownForm = 'true';
      if (first) sections.prepend(section);
      else sections.append(section);
      return add(section, title, first);
    }
  };
}

export function createSettings(settingsPanel: HTMLDialogElement, getBootstrap: () => Bootstrap, applySettings: (settings: Settings) => void, refreshBootstrap: () => Promise<void>, closeDrawer: () => void, afterSave: () => Promise<void>, bindOpen: (open: () => void) => void, open: () => void) {
const { element, value } = scopedElements(settingsPanel);
const settingsStatus = element('settingsStatus');
function fillSettings() {
  const bootstrap = getBootstrap();
  const { settings, plugins, isolation } = bootstrap;
  element<'select'>('theme').value = settings.appearance;
  element<'input'>('maxDepth').valueAsNumber = settings.subagents.maxDepth;
  element<'input'>('maxParallel').valueAsNumber = settings.subagents.maxParallel;
  element<'input'>('childProvider').value = settings.subagents.provider;
  element<'input'>('childModel').value = settings.subagents.model;
  element<'select'>('sandboxMode').value = settings.sandbox.mode;
  element<'input'>('timeout').valueAsNumber = settings.sandbox.timeoutSeconds;
  element('isolationStatus').textContent = isolation
    ? 'File tools are workspace-scoped. Linux shell isolation is available. Trusted host mode uses your user permissions.'
    : 'File tools are workspace-scoped. Shell isolation is unavailable on this host. Trusted host mode uses your user permissions.';
  element('pluginSettings').replaceChildren(...plugins.map((plugin, index) => {
    const group = document.createElement('div');
    group.className = 'plugin-group';
    if (index === 0 || Boolean(plugins[index - 1].trustedCode) !== Boolean(plugin.trustedCode)) {
      const heading = document.createElement('h4'); heading.textContent = plugin.trustedCode ? 'Local plugins' : 'Built-in capabilities'; group.append(heading);
    }
    const label = document.createElement('label');
    label.className = 'switch-line';
    const description = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = plugin.title;
    const hint = document.createElement('small');
    hint.textContent = plugin.description;
    description.append(title, hint);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = plugin.id;
    input.dataset.pluginSwitch = plugin.id;
    input.setAttribute('aria-label', plugin.title);
    input.checked = Boolean(settings.plugins[plugin.id]);
    label.append(description, input);
    group.append(label);
    if (plugin.requires?.length) {
      const hint = document.createElement('small');
      hint.className = 'hint';
      hint.textContent = 'Requires: ' + plugin.requires.join(', ');
      group.append(hint);
    }
    if (plugin.configSchema) {
      const fields = document.createElement('fieldset');
      fields.disabled = !input.checked;
      fields.className = 'plugin-config';
      fields.append(schemaFields(plugin.id, plugin.configSchema, settings.pluginConfig[plugin.id] ?? {}));
      input.onchange = () => { fields.disabled = !input.checked; };
      group.append(fields);
    }
    if (plugin.trustedCode) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'small-button danger'; remove.textContent = 'Uninstall ' + plugin.title;
      remove.disabled = Boolean(settings.plugins[plugin.id]);
      remove.onclick = async () => {
        if (!confirm('Permanently uninstall ' + plugin.title + '?')) return;
        try { await data('/plugins/' + plugin.id, { method: 'DELETE' }); await refreshBootstrap(); }
        catch (error) { settingsStatus.textContent = error.message; }
      };
      group.append(remove);
    }
    return group;
  }));
  settingsStatus.textContent = '';
}

async function saveSettings() {
  const bootstrap = getBootstrap();
  const patch = {
    appearance: value('theme'),
    plugins: Object.fromEntries([...element('pluginSettings').querySelectorAll<HTMLInputElement>('[data-plugin-switch]')].map((input) => [input.name, input.checked])),
    subagents: {
      maxDepth: element<'input'>('maxDepth').valueAsNumber, maxParallel: element<'input'>('maxParallel').valueAsNumber,
      provider: value('childProvider'), model: value('childModel')
    },
    sandbox: { mode: value('sandboxMode'), timeoutSeconds: element<'input'>('timeout').valueAsNumber }
  };
  const button = element<'button'>('saveSettings');
  button.disabled = true;
  try {
    const invalid = settingsPanel.querySelector<HTMLInputElement>('#settingsSections > section:not([hidden]) :invalid');
    if (invalid) { invalid.reportValidity(); return; }
    Object.assign(patch, { pluginConfig: readPluginValues(bootstrap.settings.pluginConfig, element('pluginSettings')) });
    applySettings(await data<Settings>('/settings', payload('PATCH', patch)));
    await afterSave();
    fillSettings(); settingsStatus.textContent = 'Saved.';
  } catch (error) { settingsStatus.textContent = error.message; }
  finally { button.disabled = false; }
}

bindOpen(() => {
  if (!getBootstrap()) return;
  fillSettings();
  closeDrawer();
  open();
});
element('settingsClose').onclick = () => settingsPanel.close();
element('saveSettings').onclick = () => void saveSettings();
element('theme').onchange = async () => {
  try { applySettings(await data<Settings>('/settings', payload('PATCH', { appearance: value('theme') }))); }
  catch (error) { settingsStatus.textContent = error.message; }
};
return { fillSettings };
}
