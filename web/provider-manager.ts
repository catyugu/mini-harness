import { scopedElements, data, payload } from './api.js';
import { fromMarkup } from './primitives.js';

export interface ProviderInfo {
  id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; api: string;
  models: { id: string; name: string; input: string[]; contextWindow: number; maxTokens: number; reasoning: boolean }[];
}

export function modelSettingsPage() {
  return fromMarkup(`<section data-icon-name="model">
    <h3>Model</h3>
    <div id="configuredProviders" class="provider-list"></div>
    <section class="provider-editor">
      <h4>Default model and credentials</h4>
      <div class="setting-columns">
        <div><label for="provider">Provider</label><select id="provider"></select></div>
        <div><label for="model">Model ID</label><select id="model"></select></div>
      </div>
      <label for="apiKey">API key</label><input id="apiKey" type="password" autocomplete="off">
      <div class="inline-actions">
        <button id="saveCredential" class="small-button" type="button">Save API key</button>
        <button id="refreshModels" class="link-button" type="button">Refresh models</button>
      </div>
      <p id="credentialStatus" class="hint" role="status"></p>
    </section>
    <div id="providerSettings"></div>
  </section>`);
}

export function providerManager(panel: HTMLElement, providers: () => ProviderInfo[], refresh: () => Promise<void>) {
  const { element, value } = scopedElements(panel);
  const editor = fromMarkup<HTMLDetailsElement>(`<details class="endpoint-editor provider-editor">
    <summary>Custom API endpoint</summary>
    <div class="endpoint-fields">
      <div class="setting-columns">
        <div><label for="customProvider">Provider ID</label><input id="customProvider" placeholder="my-provider" pattern="[a-z0-9][a-z0-9-]{0,63}"></div>
        <div><label for="customApi">API format</label><select id="customApi"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select></div>
      </div>
      <label for="customEndpoint">API endpoint</label><input id="customEndpoint" type="url" placeholder="https://api.example.com/v1">
      <label for="customModels">Model IDs (one per line)</label><textarea id="customModels" rows="3" placeholder="model-id"></textarea>
      <details class="model-options">
        <summary>Per-model options</summary>
        <div id="endpointModels"></div>
      </details>
      <div class="inline-actions">
        <button id="resetProvider" type="button" class="link-button">New endpoint</button>
        <button id="saveProvider" type="button" class="small-button">Save endpoint</button>
      </div>
      <p id="providerStatus" class="hint" role="status"></p>
    </div>
  </details>`);
  element('providerSettings').append(editor);
  editor.open = !providers().some((provider) => provider.configured);
  const ids = element<'textarea'>('customModels');
  const modelIds = () => ids.value.split('\n').map((id) => id.trim()).filter(Boolean);
  type Model = ProviderInfo['models'][number];
  const existingModels = new Map<string, Model>();
  const status = element('providerStatus');
  function syncModelRows() {
    const container = element('endpointModels');
    const previous = new Map([...container.querySelectorAll<HTMLFieldSetElement>('fieldset')].map((row) => [row.dataset.id, row]));
    container.replaceChildren(...[...new Set(modelIds())].slice(0, 50).map((id) => {
      if (previous.has(id)) return previous.get(id);
      const model = existingModels.get(id);
      const row = fromMarkup<HTMLFieldSetElement>(`<fieldset class="endpoint-model">
        <legend></legend>
        <label>Display name<input data-model="name"></label>
        <div class="setting-columns">
          <label>Context window<input data-model="context" type="number" min="1" max="10000000"></label>
          <label>Max output tokens<input data-model="tokens" type="number" min="1" max="10000000"></label>
        </div>
        <div class="setting-columns">
          <label class="switch-line">Image input<input data-model="image" type="checkbox"></label>
          <label class="switch-line">Reasoning<input data-model="reasoning" type="checkbox"></label>
        </div>
      </fieldset>`);
      row.dataset.id = id;
      row.querySelector('legend').textContent = id;
      row.querySelector<HTMLInputElement>('[data-model="name"]').value = model?.name ?? id;
      row.querySelector<HTMLInputElement>('[data-model="context"]').valueAsNumber = model?.contextWindow ?? 128000;
      row.querySelector<HTMLInputElement>('[data-model="tokens"]').valueAsNumber = model?.maxTokens ?? 8192;
      row.querySelector<HTMLInputElement>('[data-model="image"]').checked = model?.input.includes('image') ?? false;
      row.querySelector<HTMLInputElement>('[data-model="reasoning"]').checked = model?.reasoning ?? false;
      return row;
    }));
  }
  ids.oninput = syncModelRows;

  function select(provider: ProviderInfo) {
    element<'select'>('provider').value = provider.id;
    element('provider').dispatchEvent(new Event('change'));
    element<'input'>('apiKey').focus();
  }

  function loadEndpoint(provider?: ProviderInfo) {
    element<'input'>('customProvider').value = provider?.id ?? '';
    element<'input'>('customProvider').readOnly = Boolean(provider);
    element<'input'>('customEndpoint').value = provider?.baseUrl ?? '';
    element<'select'>('customApi').value = provider?.api ?? 'openai-completions';
    ids.value = provider?.models.map((model) => model.id).join('\n') ?? '';
    existingModels.clear();
    for (const model of provider?.models ?? []) existingModels.set(model.id, model);
    element('endpointModels').replaceChildren();
    syncModelRows();
    status.textContent = '';
    editor.open = true;
  }
  element('resetProvider').onclick = () => { loadEndpoint(); element('customProvider').focus(); };
  element('saveProvider').onclick = async () => {
    const button = element<'button'>('saveProvider');
    button.disabled = true;
    try {
      syncModelRows();
      const rows = new Map([...element('endpointModels').querySelectorAll<HTMLFieldSetElement>('fieldset')].map((row) => [row.dataset.id, row]));
      if (modelIds().length > 50) throw new Error('Provide 1–50 models');
      const models = modelIds().map((id) => {
        const row = rows.get(id);
        const read = (field: string) => row.querySelector<HTMLInputElement>('[data-model="' + field + '"]');
        return {
          id, name: read('name').value.trim() || id,
          input: read('image').checked ? ['text', 'image'] : ['text'], reasoning: read('reasoning').checked,
          contextWindow: read('context').valueAsNumber, maxTokens: read('tokens').valueAsNumber
        };
      });
      const id = value('customProvider');
      await data('/providers', payload('PUT', { id, api: value('customApi'), baseUrl: value('customEndpoint'), models }));
      await refresh();
      const provider = providers().find((item) => item.id === id);
      if (provider) { loadEndpoint(provider); select(provider); }
      status.textContent = 'Endpoint saved. Set its API key, then choose a model.';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };

  function render() {
    const list = element('configuredProviders');
    list.replaceChildren(...providers().filter(({ configured, custom }) => configured || custom).map((provider) => {
      const row = fromMarkup(`<div class="provider-row">
        <div><strong></strong><span class="provider-state"></span></div>
        <div class="inline-actions"><button type="button" class="link-button">Credentials</button></div>
      </div>`);
      row.querySelector('strong').textContent = provider.name;
      const state = row.querySelector<HTMLElement>('.provider-state');
      state.textContent = provider.configured ? 'Configured' : 'Needs API key';
      state.dataset.connected = String(provider.configured);
      const credentials = row.querySelector('button');
      credentials.setAttribute('aria-label', 'Credentials for ' + provider.name);
      credentials.onclick = () => select(provider);
      if (provider.custom) {
        const actions = row.querySelector('.inline-actions');
        const edit = fromMarkup<HTMLButtonElement>('<button type="button" class="link-button">Edit</button>');
        edit.setAttribute('aria-label', 'Edit endpoint ' + provider.name);
        edit.onclick = () => { loadEndpoint(provider); element('customEndpoint').focus(); };
        const remove = fromMarkup<HTMLButtonElement>('<button type="button" class="link-button danger">Remove</button>');
        remove.setAttribute('aria-label', 'Remove endpoint ' + provider.name);
        remove.onclick = async () => {
          if (!confirm('Remove custom endpoint ' + provider.id + '?')) return;
          remove.disabled = true;
          try {
            await data('/providers', payload('DELETE', { id: provider.id }));
            await refresh();
            if (value('customProvider') === provider.id) loadEndpoint();
            editor.open = true;
            status.textContent = 'Endpoint removed.';
          } catch (error) { editor.open = true; status.textContent = error.message; }
          finally { remove.disabled = false; }
        };
        actions.append(edit, remove);
      }
      return row;
    }));
  }
  render();
  return { render, dispose: () => editor.remove() };
}

export function populateProviders(panel: HTMLElement, providers: ProviderInfo[], provider: string, model: string) {
  const { element } = scopedElements(panel);
  const select = element<'select'>('provider');
  select.replaceChildren(new Option('Auto provider', ''));
  const configured = document.createElement('optgroup'); configured.label = 'Configured';
  const catalog = document.createElement('optgroup'); catalog.label = 'Other providers';
  for (const item of [...providers].sort((a, b) => a.name.localeCompare(b.name))) {
    (item.configured ? configured : catalog).append(new Option(item.name + (item.custom ? ' · Custom' : ''), item.id));
  }
  select.append(configured, catalog); select.value = provider;
  populateModels(panel, providers, provider, model);
}
export function populateModels(panel: HTMLElement, providers: ProviderInfo[], provider: string, model = '') {
  const { element } = scopedElements(panel);
  const select = element<'select'>('model'); select.replaceChildren(new Option('Auto model', ''));
  for (const item of providers.find((p) => p.id === provider)?.models ?? []) select.add(new Option(item.name || item.id, item.id));
  select.value = model;
}
