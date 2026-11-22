import { element, value, data, payload } from './api.js';
import type { FrontendApi } from './extensions.js';
export interface ProviderInfo { id: string; name: string; configured: boolean; custom: boolean; baseUrl: string; api: string;
  models: { id: string; name: string; input: string[]; contextWindow: number; maxTokens: number; reasoning: boolean }[] }
export function providerManager(api: FrontendApi, providers: () => ProviderInfo[], refresh: () => Promise<void>, report: (error: Error) => void) {
  const section = document.createElement('section'); section.innerHTML = `
    <h3>Custom API endpoint</h3><p class="hint">Add an OpenAI compatible or native API. Credentials stay in your local configuration.</p>
    <label for="customProvider">Provider ID</label><input id="customProvider" placeholder="my-provider" pattern="[a-z0-9][a-z0-9-]{0,63}">
    <label for="customEndpoint">API endpoint</label><input id="customEndpoint" type="url" placeholder="https://api.example.com/v1">
    <label for="customApi">API format</label><select id="customApi"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Generative AI</option></select>
    <label for="customModels">Model IDs (one per line)</label><textarea id="customModels" rows="3" placeholder="model-id"></textarea>
    <div class="setting-columns"><div><label for="contextWindow">Context window</label><input id="contextWindow" type="number" min="1" value="128000"></div><div><label for="maxTokens">Maximum output tokens</label><input id="maxTokens" type="number" min="1" value="8192"></div></div>
    <label class="switch-line"><span>Image input</span><input id="imageInput" type="checkbox"></label>
    <label class="switch-line"><span>Reasoning model</span><input id="reasoningModel" type="checkbox"></label>
    <button id="editProvider" type="button" class="small-button">Edit selected provider</button>
    <button id="saveProvider" type="button" class="small-button">Save endpoint</button>
    <button id="removeProvider" type="button" class="small-button danger">Remove selected endpoint</button>
    <p id="providerStatus" class="hint" role="status"></p>`;
  api.mount('settings', section);
  const status = (text: string) => { element('providerStatus').textContent = text; };
  element('editProvider').onclick = () => {
    const provider = providers().find((p) => p.id === value('provider'));
    if (!provider?.custom) { status('Select a custom provider in Model settings first.'); return; }
    element<'input'>('customProvider').value = provider.id; element<'input'>('customEndpoint').value = provider.baseUrl;
    element<'select'>('customApi').value = provider.api; element<'textarea'>('customModels').value = provider.models.map((m) => m.id).join('\n');
    const model = provider.models[0];
    element<'input'>('contextWindow').valueAsNumber = model?.contextWindow ?? 128000;
    element<'input'>('maxTokens').valueAsNumber = model?.maxTokens ?? 8192;
    element<'input'>('imageInput').checked = model?.input.includes('image') ?? false;
    element<'input'>('reasoningModel').checked = model?.reasoning ?? false;
    status('Loaded ' + provider.id);
  };
  element('saveProvider').onclick = async () => {
    const button = element<'button'>('saveProvider'); button.disabled = true;
    try {
      const id = value('customProvider'), existing = providers().find((p) => p.id === id);
      await data('/providers', payload('PUT', { id, api: value('customApi'), baseUrl: value('customEndpoint'),
        models: value('customModels').split('\n').map((id) => id.trim()).filter(Boolean).map((modelId) => {
          const old = existing?.models.find((m) => m.id === modelId);
          return { ...old, id: modelId, name: old?.name ?? modelId, input: element<'input'>('imageInput').checked ? ['text', 'image'] : ['text'],
            reasoning: element<'input'>('reasoningModel').checked, contextWindow: element<'input'>('contextWindow').valueAsNumber, maxTokens: element<'input'>('maxTokens').valueAsNumber };
        }) }));
      await refresh();
      element<'select'>('provider').value = id; element('provider').dispatchEvent(new Event('change'));
      status('Endpoint saved. Save its API key above, choose a model, then save settings.');
    } catch (error) { status(error.message); } finally { button.disabled = false; }
  };
  element('removeProvider').onclick = async () => {
    const id = value('provider');
    if (!confirm('Remove custom endpoint ' + id + '?')) return;
    try { await data('/providers', payload('DELETE', { id })); await refresh(); status('Endpoint removed.'); }
    catch (error) { status(error.message); }
  };
}
export function populateProviders(providers: ProviderInfo[], provider: string, model: string) {
  const select = element<'select'>('provider');
  select.replaceChildren(new Option('Auto provider', ''));
  const configured = document.createElement('optgroup'); configured.label = 'Configured';
  const catalog = document.createElement('optgroup'); catalog.label = 'Other providers';
  for (const item of [...providers].sort((a, b) => a.name.localeCompare(b.name))) {
    (item.configured ? configured : catalog).append(new Option(item.name + (item.custom ? ' · Custom' : ''), item.id));
  }
  select.append(configured, catalog); select.value = provider;
  populateModels(providers, provider, model);
}
export function populateModels(providers: ProviderInfo[], provider: string, model = '') {
  const select = element<'select'>('model'); select.replaceChildren(new Option('Auto model', ''));
  for (const item of providers.find((p) => p.id === provider)?.models ?? []) select.add(new Option(item.name || item.id, item.id));
  select.value = model;
}
