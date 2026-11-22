import type { Settings } from '../src/config.js';
import type { Bootstrap, ModelInfo } from './types.js';
import { element, value, data, payload } from './api.js';
import { schemaFields, readPluginValues } from './settings-fields.js';
import { populateProviders, populateModels } from './provider-manager.js';
export function createSettings(getBootstrap: () => Bootstrap, applySettings: (settings: Settings) => void, refreshBootstrap: () => Promise<void>, closeDrawer: () => void, afterSave: () => Promise<void>) {
const settingsPanel = element<'dialog'>('settingsPanel'), settingsStatus = element('settingsStatus');
function fillSettings() {
  const bootstrap = getBootstrap();
  const { settings, plugins, isolation } = bootstrap;
  element<'select'>('theme').value = settings.appearance;
  populateProviders(bootstrap.providers, settings.model.provider, settings.model.id);
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
  credentialStatus();
  settingsStatus.textContent = '';
}

function credentialStatus() {
  const bootstrap = getBootstrap();
  const provider = value('provider');
  element('credentialStatus').textContent = !provider ? 'Select a provider to configure credentials.' :
    bootstrap.models.some((model) => model.provider === provider && model.configured) ? 'Credentials configured.' : 'Credentials needed.';
}

async function saveSettings() {
  const bootstrap = getBootstrap();
  const patch = {
    appearance: value('theme'),
    model: { provider: value('provider'), id: value('model') },
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
    Object.assign(patch, { pluginConfig: readPluginValues(bootstrap.settings.pluginConfig) });
    applySettings(await data<Settings>('/settings', payload('PATCH', patch)));
    await afterSave();
    fillSettings(); settingsStatus.textContent = 'Saved.';
  } catch (error) { settingsStatus.textContent = error.message; }
  finally { button.disabled = false; }
}

element('settingsOpen').onclick = () => {
  if (!getBootstrap()) return;
  fillSettings();
  closeDrawer();
  settingsPanel.showModal();
};
element('settingsClose').onclick = () => settingsPanel.close();
element<'form'>('settingsForm').onsubmit = (event) => { event.preventDefault(); void saveSettings(); };
element('saveCredential').onclick = async () => {
  const bootstrap = getBootstrap();
  const chosenProvider = value('provider'), chosenModel = value('model');
  try {
    const result = await data<{ models: ModelInfo[] }>('/credentials', payload('POST', { provider: chosenProvider, key: value('apiKey') }));
    bootstrap.models = result.models;
    applySettings(bootstrap.settings);
    await refreshBootstrap();
    populateProviders(getBootstrap().providers, chosenProvider, chosenModel);
    credentialStatus();
    element<'input'>('apiKey').value = '';
    settingsStatus.textContent = 'API key saved locally.';
  } catch (error) { settingsStatus.textContent = error.message; }
};
element('provider').onchange = () => { populateModels(getBootstrap().providers, value('provider')); credentialStatus(); };
element('refreshModels').onclick = async () => {
  const bootstrap = getBootstrap();
  try {
    bootstrap.models = (await data<{ models: ModelInfo[] }>('/models')).models;
    applySettings(bootstrap.settings);
    credentialStatus();
    settingsStatus.textContent = 'Model status refreshed.';
  } catch (error) { settingsStatus.textContent = error.message; }
};
element('theme').onchange = async () => {
  try { applySettings(await data<Settings>('/settings', payload('PATCH', { appearance: value('theme') }))); }
  catch (error) { settingsStatus.textContent = error.message; }
};
return { fillSettings, credentialStatus };
}
