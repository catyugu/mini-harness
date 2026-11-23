import { payload } from '../web/api.js';
import type { FrontendSetup, FrontendApi } from '../ui-runtime/frontend.js';
import { icon } from '../ui-primitives/icons.js';
import { button, field, fromMarkup } from '../ui-primitives/primitives.js';

import type { ProviderInfo, ProviderModel } from '../web/contracts/providers.js';

const setup: FrontendSetup = (ctx, api) => {
  const { miniSettings: settings, miniModels: state } = ctx;
  const manager = providerManager(api, () => state.get().providers, state.refresh);
  api.onDispose(settings.addPage('Model', manager.content, true));
  settings.onClose(manager.reset, api.signal);
  state.subscribe(manager.render, api.signal);
  if (!state.get().models.some((model) => model.configured)) settings.open(true);
};

function providerManager(api: FrontendApi, providers: () => ProviderInfo[], refresh: () => Promise<void>) {
  const content = fromMarkup(`<div class="model-settings">
    <div class="provider-list"></div>
    <div class="provider-add"></div>
    <p class="hint provider-status" role="status"></p>
  </div>`);
  const list = content.querySelector<HTMLElement>('.provider-list');
  const addArea = content.querySelector<HTMLElement>('.provider-add');
  const status = content.querySelector<HTMLElement>('[role="status"]');
  const add = button('Add provider', 'quiet');
  add.prepend(icon('plus'));
  let activeEditor: HTMLElement;

  function closeEditor() {
    activeEditor?.remove();
    activeEditor = undefined;
    add.hidden = false;
  }

  function edit(mount: HTMLElement, provider?: ProviderInfo) {
    closeEditor();
    status.textContent = '';
    const form = fromMarkup<HTMLFormElement>('<form class="provider-editor"></form>');
    form.setAttribute('aria-label', provider ? 'Edit ' + provider.name : 'Add provider');
    const mode = fromMarkup<HTMLFieldSetElement>(`<fieldset class="provider-mode"><legend>Provider type</legend>
      <label><input type="radio" name="provider-type" value="catalog" checked> Pi provider</label>
      <label><input type="radio" name="provider-type" value="custom"> Custom API</label>
    </fieldset>`);
    const available = providers().filter(({ configured, custom, canSetKey }) => canSetKey && !configured && !custom)
      .sort((a, b) => a.name.localeCompare(b.name));
    const picker = document.createElement('select');
    picker.required = true;
    picker.add(new Option('Choose a provider', ''));
    for (const item of available) picker.add(new Option(item.name, item.id));
    const catalog = field('Provider', picker);
    const endpoint = customEndpoint(provider);
    const key = fromMarkup<HTMLInputElement>('<input type="password" autocomplete="new-password">');
    if (provider?.configured) key.placeholder = 'Leave blank to keep the current key';
    const credentials = field('API key', key);
    const cancel = button('Cancel', 'quiet');
    const save = button('Save', 'primary');
    save.type = 'submit';
    const actions = fromMarkup('<div class="ui-actions"></div>');
    const error = fromMarkup('<p class="hint form-error" role="alert"></p>');
    cancel.onclick = () => { closeEditor(); mount.closest('.ui-card')?.querySelector('button')?.focus(); if (!provider) add.focus(); };
    actions.append(cancel, save);
    form.append(mode, catalog, endpoint.element, credentials, error, actions);
    const custom = () => provider?.custom ?? (form.elements.namedItem('provider-type') as RadioNodeList).value === 'custom';
    function updateMode() {
      mode.hidden = Boolean(provider);
      catalog.hidden = Boolean(provider) || custom();
      picker.disabled = catalog.hidden;
      endpoint.element.hidden = !custom();
      endpoint.element.disabled = !custom();
      key.required = !custom() && !provider?.configured;
    }
    mode.onchange = updateMode;
    updateMode();
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (save.disabled) return;
      error.textContent = '';
      save.disabled = true;
      try {
        const secret = key.value.trim();
        if (custom()) {
          await api.request('/providers', payload('PUT', { ...endpoint.read(), key: secret || undefined, create: !provider }));
        } else if (secret) {
          await api.request('/credentials', payload('POST', { provider: provider?.id ?? picker.value, key: secret }));
        }
        closeEditor();
        await refresh();
        status.textContent = 'Provider saved.';
        list.querySelector<HTMLButtonElement>('[data-provider="' + (provider?.id ?? (custom() ? endpoint.id.value : picker.value)) + '"]')?.focus();
      } catch (failure) {
        (form.isConnected ? error : status).textContent = failure.message;
      } finally { save.disabled = false; }
    };
    activeEditor = form;
    add.hidden = !provider;
    mount.append(form);
    (provider ? provider.custom ? endpoint.url : key : picker).focus();
  }

  function render() {
    closeEditor();
    const configured = providers().filter(({ configured, custom }) => configured || custom)
      .sort((a, b) => a.name.localeCompare(b.name));
    list.replaceChildren(...configured.map((provider) => {
      const card = fromMarkup(`<article class="ui-card provider-card">
        <div class="provider-row"><div><strong></strong><small class="provider-state"></small></div><div class="ui-actions"></div></div>
        <div class="provider-inline"></div>
      </article>`);
      card.querySelector('strong').textContent = provider.name;
      const summary = card.querySelector<HTMLElement>('.provider-state');
      summary.textContent = provider.configured ? 'Configured · ' + provider.models.length + (provider.models.length === 1 ? ' model' : ' models') : 'API key needed';
      summary.dataset.connected = String(provider.configured);
      const actions = card.querySelector('.ui-actions');
      const editButton = button('Edit', 'quiet');
      editButton.dataset.provider = provider.id;
      editButton.setAttribute('aria-label', 'Edit ' + provider.name);
      editButton.onclick = () => edit(card.querySelector('.provider-inline'), provider);
      if (provider.custom || provider.canSetKey) actions.append(editButton);
      if (provider.custom || provider.storedCredential) {
        const remove = button('Remove', 'quiet');
        remove.classList.add('danger');
        remove.setAttribute('aria-label', 'Remove ' + provider.name);
        remove.onclick = async () => {
          if (!confirm(provider.custom ? 'Remove endpoint ' + provider.name + '?' : 'Remove the saved credentials for ' + provider.name + '?')) return;
          remove.disabled = true;
          try {
            await api.request(provider.custom ? '/providers' : '/credentials', payload('DELETE',
              provider.custom ? { id: provider.id } : { provider: provider.id }));
            await refresh();
            status.textContent = 'Provider removed.';
            add.focus();
          } catch (error) { status.textContent = error.message; }
          finally { remove.disabled = false; }
        };
        actions.append(remove);
      }
      return card;
    }));
    if (!configured.length) list.append(fromMarkup('<p class="hint">Add a provider to make its models available in the composer.</p>'));
  }
  add.onclick = () => edit(addArea);
  addArea.append(add);
  render();
  return { content, render, reset: () => { closeEditor(); status.textContent = ''; } };
}

function customEndpoint(provider?: ProviderInfo) {
  const element = fromMarkup<HTMLFieldSetElement>(`<fieldset class="endpoint-fields" aria-label="Custom API">
    <div class="setting-columns">
      <label>Provider ID<input name="id" placeholder="my-provider" pattern="[a-z0-9](?:[a-z0-9]|-){0,63}" required></label>
      <label>API format<select name="api"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></label>
    </div>
    <label>API endpoint<input name="url" type="url" placeholder="https://api.example.com/v1" required></label>
    <div class="endpoint-models"></div>
  </fieldset>`);
  const id = element.querySelector<HTMLInputElement>('[name="id"]');
  const api = element.querySelector<HTMLSelectElement>('[name="api"]');
  const url = element.querySelector<HTMLInputElement>('[name="url"]');
  id.value = provider?.id ?? '';
  id.readOnly = Boolean(provider);
  api.value = provider?.api ?? 'openai-completions';
  url.value = provider?.baseUrl ?? '';
  const models = element.querySelector('.endpoint-models');
  const add = button('Add model', 'quiet');
  add.prepend(icon('plus'));
  element.append(add);
  const readModels = new Map<HTMLElement, () => ProviderModel>();
  function syncButtons() {
    add.disabled = readModels.size >= 50;
    for (const remove of models.querySelectorAll<HTMLButtonElement>('button')) remove.disabled = readModels.size === 1;
  }
  function modelRow(model?: ProviderModel) {
    const row = fromMarkup(`<fieldset class="endpoint-model">
      <legend>Model</legend>
      <div class="setting-columns">
        <label>Model ID<input name="model-id" maxlength="160" required></label>
        <label>Display name<input name="model-name" maxlength="160"></label>
      </div>
      <div class="setting-columns">
        <label>Context window<input name="context" type="number" min="1" max="10000000" required></label>
        <label>Max output tokens<input name="tokens" type="number" min="1" max="10000000" required></label>
      </div>
      <div class="setting-columns">
        <label class="switch-line">Image input<input name="image" type="checkbox"></label>
        <label class="switch-line">Reasoning<input name="reasoning" type="checkbox"></label>
      </div>
    </fieldset>`);
    const [id, name, context, tokens, image, reasoning] = row.querySelectorAll('input');
    id.value = model?.id ?? '';
    name.value = model?.name ?? '';
    context.valueAsNumber = model?.contextWindow ?? 128000;
    tokens.valueAsNumber = model?.maxTokens ?? 8192;
    image.checked = model?.input.includes('image') ?? false;
    reasoning.checked = model?.reasoning ?? false;
    const remove = button('Remove model', 'quiet');
    remove.onclick = () => { row.remove(); readModels.delete(row); syncButtons(); add.focus(); };
    row.append(remove);
    readModels.set(row, () => ({
      id: id.value.trim(), name: name.value.trim() || id.value.trim(),
      contextWindow: context.valueAsNumber, maxTokens: tokens.valueAsNumber,
      input: image.checked ? ['text', 'image'] : ['text'], reasoning: reasoning.checked
    }));
    models.append(row);
    syncButtons();
    return id;
  }
  add.onclick = () => modelRow().focus();
  if (provider?.models.length) for (const model of provider.models) modelRow(model);
  else modelRow();
  return { element, id, url, read: () => ({
    id: id.value.trim(), api: api.value, baseUrl: url.value.trim(), models: [...readModels.values()].map((read) => read())
  }) };
}

export default setup;
