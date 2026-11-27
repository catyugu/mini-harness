import type { Context } from 'mini-harness/cordis';
import { browserRequest, payload } from '@mini-harness/ui-runtime/http';
import { button, field, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
import type {
  ProtocolInfo,
  ProviderInfo,
  ProviderModel,
  ProviderModelDefinition,
} from '../shared/catalog.ts';
import { catalogEditor, selectDiscovered } from './catalog-editor.ts';

export function providerEditor(
  ctx: Context,
  available: readonly ProviderInfo[],
  provider: ProviderInfo | undefined,
  protocols: readonly ProtocolInfo[],
  signal: AbortSignal,
  actions: { cancel(): void; saved(id: string): void },
) {
  const form = fromMarkup<HTMLFormElement>(`<form class="provider-editor" novalidate>
    <fieldset class="provider-mode" aria-label="Provider type">
      <label class="ui-button"><input type="radio" name="provider-type" value="builtin" checked>Built-in provider</label>
      <label class="ui-button"><input type="radio" name="provider-type" value="custom">Custom API</label>
    </fieldset>
    <select aria-label="Provider" data-initial-focus required><option value="">Choose a provider</option></select>
    <fieldset class="provider-fields">
      <label class="ui-field">Provider ID<input name="id" placeholder="my-provider" pattern="[a-z0-9](?:[a-z0-9]|-){0,63}" required></label>
      <label class="ui-field">Display name<input name="name" maxlength="160" placeholder="My Provider"></label>
    </fieldset>
    <div class="provider-custom-connection"></div>
    <label class="ui-field provider-key">API key<input name="key" type="password" autocomplete="new-password"></label>
    <details class="provider-options"><summary>Custom settings</summary><div class="provider-options-body"></div></details>
    <div class="provider-catalog"></div>
    <p class="form-error provider-status" role="alert"></p>
    <footer class="ui-actions"></footer>
  </form>`);
  form.setAttribute('aria-label', provider ? 'Edit ' + provider.name : 'Add provider');
  const mode = required(form.querySelector<HTMLFieldSetElement>('.provider-mode'));
  const picker = required(form.querySelector('select'));
  const providerField = field('Provider', picker);
  mode.after(providerField);
  const fields = required(form.querySelector<HTMLFieldSetElement>('.provider-fields'));
  const id = required(form.querySelector<HTMLInputElement>('[name="id"]'));
  const name = required(form.querySelector<HTMLInputElement>('[name="name"]'));
  const key = required(form.querySelector<HTMLInputElement>('[name="key"]'));
  const keyField = required(key.closest('label'));
  const details = required(form.querySelector('details'));
  const optionsBody = required(form.querySelector('.provider-options-body'));
  const customConnection = required(form.querySelector<HTMLElement>('.provider-custom-connection'));
  const customCatalog = required(form.querySelector<HTMLElement>('.provider-catalog'));
  const error = required(form.querySelector('[role="alert"]'));
  const endpoint = fromMarkup<HTMLInputElement>(
    '<input type="url" placeholder="https://api.example.com/v1">',
  );
  const endpointField = field('API endpoint', endpoint);
  const api = document.createElement('select');
  const apiField = field('API protocol', api);
  const catalog = catalogEditor();
  const restoreEndpoint = button('Use default endpoint', 'quiet');
  const restoreModels = button('Restore default models', 'quiet');
  const discover = button('Fetch available models', 'quiet');
  const cancel = button('Cancel', 'quiet');
  const save = button(provider ? 'Save changes' : 'Create provider', 'primary');
  required(form.querySelector('footer')).append(cancel, save);
  save.type = 'submit';
  cancel.onclick = actions.cancel;
  const report = (failure: unknown) => {
    if (!signal.aborted) error.textContent = failure instanceof Error ? failure.message : String(failure);
  };
  const availableById = new Map(available.map((item) => [item.id, item]));
  for (const item of [...available].sort((a, b) => a.name.localeCompare(b.name)))
    picker.add(new Option(item.name, item.id));
  mode.hidden = Boolean(provider);
  id.readOnly = Boolean(provider);

  const custom = () =>
    provider?.custom ?? required(mode.querySelector<HTMLInputElement>(':checked')).value === 'custom';
  const builtin = () => (custom() ? undefined : (provider ?? availableById.get(picker.value)));
  let discovery: AbortController | undefined;
  let restore: AbortController | undefined;

  function resetDiscovery() {
    discovery?.abort();
    discovery = undefined;
    discover.textContent = 'Fetch available models';
    const { baseUrl, api } = connection();
    discover.disabled = !baseUrl;
    discover.hidden = !protocols.some((protocol) => protocol.api === api);
  }

  function connection() {
    const selected = builtin();
    return {
      baseUrl: endpoint.value.trim() || selected?.defaultBaseUrl || '',
      api: selected?.api ?? (custom() ? api.value : ''),
    };
  }

  function updateFields() {
    restore?.abort();
    restore = undefined;
    restoreModels.disabled = false;
    const isCustom = custom();
    const selected = isCustom ? provider : builtin();
    providerField.hidden = isCustom || Boolean(provider);
    picker.disabled = providerField.hidden;
    fields.hidden = fields.disabled = !isCustom;
    details.hidden = isCustom || !selected;
    details.open = false;
    keyField.hidden = !isCustom && !selected?.canSetKey;
    key.disabled = keyField.hidden;
    key.value = '';
    key.placeholder = selected?.storedCredential ? 'Leave blank to keep the saved key' : 'Enter API key';
    id.value = selected?.id ?? '';
    name.value = isCustom ? (selected?.name ?? '') : '';
    endpoint.value = isCustom || selected?.endpointCustomized ? (selected?.baseUrl ?? '') : '';
    endpoint.placeholder = isCustom ? 'https://api.example.com/v1' : (selected?.defaultBaseUrl ?? '');
    endpoint.required = isCustom;
    const options: [string, string][] = protocols.map(({ api, label }) => [api, label]);
    const protocol = selected?.api ?? options[0]?.[0] ?? '';
    if (!protocols.some(({ api }) => api === protocol)) options.push([protocol, protocol]);
    api.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
    api.value = protocol;
    api.disabled = !isCustom;
    customConnection.hidden = customCatalog.hidden = !isCustom;
    if (isCustom) {
      customConnection.append(endpointField, apiField);
      customCatalog.append(catalog.root);
      catalog.actions.replaceChildren(discover);
    } else {
      optionsBody.append(endpointField, restoreEndpoint, catalog.root);
      apiField.remove();
      catalog.actions.replaceChildren(discover, restoreModels);
    }
    catalog.reset(selected?.models ?? [], isCustom || Boolean(selected?.modelsCustomized));
    error.textContent = '';
    resetDiscovery();
  }

  restoreEndpoint.onclick = () => {
    endpoint.value = '';
    resetDiscovery();
    endpoint.focus();
  };
  restoreModels.onclick = async () => {
    const selected = builtin();
    if (!selected) return;
    const controller = (restore = new AbortController());
    restoreModels.disabled = true;
    error.textContent = '';
    try {
      const models = await browserRequest<ProviderModelDefinition[]>(
        ctx,
        '/providers/' + encodeURIComponent(selected.id) + '/default-models',
        {
          signal: AbortSignal.any([controller.signal, signal]),
        },
      );
      if (!controller.signal.aborted && !signal.aborted) {
        catalog.reset(models, false);
      }
    } catch (failure) {
      if (!controller.signal.aborted) report(failure);
    } finally {
      if (restore === controller) restoreModels.disabled = false;
    }
  };

  discover.onclick = async () => {
    if (discovery || !endpoint.checkValidity()) {
      if (!endpoint.checkValidity()) report(endpoint.validationMessage);
      return;
    }
    error.textContent = '';
    const controller = (discovery = new AbortController());
    const lifetime = AbortSignal.any([controller.signal, signal]);
    discover.disabled = true;
    discover.textContent = 'Fetching models…';
    try {
      const models = await browserRequest<ProviderModel[]>(ctx, '/providers/discovery', {
        ...payload('POST', { ...connection(), id: provider?.id ?? builtin()?.id, key: key.value.trim() }),
        signal: lifetime,
      });
      if (lifetime.aborted) return;
      if (!models.length) {
        report('The endpoint returned no available models.');
        return;
      }
      await selectDiscovered(models, new Set(catalog.models().map(({ id }) => id)), lifetime, catalog.append);
    } catch (failure) {
      if (!lifetime.aborted) report(failure);
    } finally {
      if (discovery === controller) {
        discovery = undefined;
        discover.textContent = 'Fetch available models';
        discover.disabled = false;
      }
    }
  };

  mode.onchange = picker.onchange = updateFields;
  endpoint.oninput =
    key.oninput =
    api.onchange =
      () => {
        error.textContent = '';
        resetDiscovery();
      };
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    error.textContent = '';
    const invalid = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')].find(
      (control) => !control.disabled && !control.closest('[hidden]') && !control.checkValidity(),
    );
    if (invalid) {
      for (let node: HTMLElement | null = invalid.parentElement; node; node = node.parentElement)
        if (node instanceof HTMLDetailsElement) node.open = true;
      report(invalid.validationMessage);
      invalid.focus();
      return;
    }
    const selected = builtin();
    if (
      !provider &&
      selected &&
      !selected.configured &&
      !key.value.trim() &&
      !endpoint.value.trim() &&
      !catalog.customized()
    ) {
      report('Enter an API key or customize the provider to add it.');
      return;
    }
    save.disabled = cancel.disabled = true;
    try {
      const isCustom = custom();
      const { id: saved } = await browserRequest<{ id: string }>(ctx, '/providers', {
        ...payload('PUT', {
          id: isCustom ? id.value.trim() : builtin()?.id,
          create: isCustom && !provider,
          name: isCustom ? name.value.trim() : undefined,
          api: isCustom ? api.value : undefined,
          baseUrl: endpoint.value.trim(),
          key: key.value.trim(),
          models: catalog.customized() ? catalog.models() : undefined,
        }),
        signal,
      });
      if (!signal.aborted) actions.saved(saved);
    } catch (failure) {
      report(failure);
    } finally {
      save.disabled = cancel.disabled = false;
    }
  };
  updateFields();
  return form;
}
