import type { Context } from 'mini-harness/cordis';
import { browserRequest, payload } from '@mini-harness/ui-runtime/http';
import { button, confirmAction, field, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import type { ProtocolInfo, ProviderInfo, ProviderModelDefinition } from '../shared/pi-provider.ts';
import { catalogEditor } from './catalog-editor.ts';

export function providerEditor(
  ctx: Context,
  available: readonly ProviderInfo[],
  provider: ProviderInfo | undefined,
  protocols: readonly ProtocolInfo[],
  signal: AbortSignal,
  actions: { cancel(): void; saved(id: string): void },
) {
  const form = fromMarkup<HTMLFormElement>(`<form class="provider-editor">
    <fieldset class="provider-draft"><div class="provider-fields"></div></fieldset>
    <p class="form-error" role="alert"></p>
    <footer class="ui-actions"></footer>
  </form>`);
  form.setAttribute('aria-label', provider ? 'Edit ' + provider.name : 'Add provider');
  const controls = required(form.querySelector('fieldset'));
  const fields = required(form.querySelector('.provider-fields'));
  const error = required(form.querySelector('[role="alert"]'));
  const cancel = button('Cancel', 'quiet');
  const save = button(provider ? 'Save changes' : 'Create provider', 'primary');
  required(form.querySelector('footer')).append(cancel, save);
  save.type = 'submit';
  cancel.onclick = actions.cancel;
  const report = (failure: unknown) => {
    if (!signal.aborted) error.textContent = failure instanceof Error ? failure.message : String(failure);
  };

  async function run(action: () => Promise<void>, saving = false) {
    if (controls.disabled || signal.aborted) return;
    error.textContent = '';
    controls.disabled = save.disabled = true;
    cancel.disabled = saving;
    try {
      await action();
    } catch (failure) {
      report(failure);
    } finally {
      controls.disabled = save.disabled = cancel.disabled = false;
    }
  }

  function renderDraft(selected: ProviderInfo | undefined, custom: boolean) {
    error.textContent = '';
    fields.replaceChildren();
    save.disabled = !selected && !custom;
    if (save.disabled) {
      form.onsubmit = (event) => event.preventDefault();
      return;
    }

    const id = fromMarkup<HTMLInputElement>(
      '<input placeholder="my-provider" pattern="[a-z0-9](?:[a-z0-9]|-){0,63}" required>',
    );
    const name = fromMarkup<HTMLInputElement>('<input maxlength="160" placeholder="My Provider">');
    id.value = selected?.id ?? '';
    id.readOnly = Boolean(selected);
    name.value = selected?.name ?? '';
    if (custom) fields.append(field('Provider ID', id), field('Display name', name));
    const key = fromMarkup<HTMLInputElement>('<input type="password" autocomplete="new-password">');
    key.placeholder = selected?.storedCredential ? 'Leave blank to keep the saved key' : 'Enter API key';
    if (custom || selected?.canSetKey) fields.append(field('API key', key));

    const body = fromMarkup('<div class="provider-options-body"></div>');
    const options = custom
      ? undefined
      : fromMarkup<HTMLDetailsElement>(
          '<details class="ui-disclosure"><summary>Custom settings</summary></details>',
        );
    if (options) {
      required(options.querySelector('summary')).prepend(icon('chevron'));
      options.append(body);
      options.addEventListener(
        'invalid',
        () => {
          options.open = true;
        },
        true,
      );
    }
    fields.append(options ?? body);

    const endpoint = fromMarkup<HTMLInputElement>(
      '<input type="url" placeholder="https://api.example.com/v1">',
    );
    endpoint.required = custom;
    endpoint.value = custom || selected?.endpointCustomized ? (selected?.baseUrl ?? '') : '';
    if (!custom) endpoint.placeholder = selected?.defaultBaseUrl ?? '';
    body.append(field('API endpoint', endpoint));
    const api = document.createElement('select');
    if (custom) {
      for (const protocol of protocols) api.add(new Option(protocol.label, protocol.api));
      if (selected) api.value = selected.api;
      api.required = true;
      body.append(field('API protocol', api));
    }
    const connection = () => ({
      baseUrl: endpoint.value.trim() || selected?.defaultBaseUrl || '',
      api: custom ? api.value : (selected?.api ?? ''),
    });
    const catalog = catalogEditor();
    catalog.reset(selected?.models ?? [], custom || Boolean(selected?.modelsCustomized));
    body.append(catalog.root);
    const discover = button('Fetch available models', 'quiet');
    if (!custom && selected) {
      const restore = button('Restore default models', 'quiet');
      catalog.actions.append(restore);
      restore.onclick = () =>
        run(async () => {
          const models = await browserRequest<ProviderModelDefinition[]>(
            ctx,
            '/providers/' + encodeURIComponent(selected.id) + '/default-models',
            { signal },
          );
          if (!signal.aborted) catalog.reset(models, false);
        });
    }
    catalog.actions.append(discover);
    function updateDiscovery() {
      discover.hidden = !protocols.some(({ api }) => api === connection().api);
      discover.disabled = !connection().baseUrl;
    }
    endpoint.oninput = api.onchange = updateDiscovery;
    updateDiscovery();
    discover.onclick = () => {
      if (!endpoint.reportValidity()) return;
      return run(async () => {
        discover.textContent = 'Fetching models…';
        try {
          const found = await browserRequest<ProviderModelDefinition[]>(ctx, '/providers/discovery', {
            ...payload('POST', { ...connection(), id: selected?.id, key: key.value.trim() }),
            signal,
          });
          if (signal.aborted) return;
          if (!found.length) throw new Error('The endpoint returned no available models.');
          await catalog.select(found, signal);
        } finally {
          discover.textContent = 'Fetch available models';
        }
      });
    };

    form.onsubmit = (event) => {
      event.preventDefault();
      if (save.disabled) return;
      let models = catalog.value();
      if (
        !provider &&
        selected &&
        !selected.configured &&
        !key.value.trim() &&
        !endpoint.value.trim() &&
        models === undefined
      ) {
        report('Enter an API key or customize the provider to add it.');
        return;
      }
      void run(async () => {
        if (
          provider?.custom &&
          provider.api !== api.value &&
          models?.some(
            ({ compat, thinkingLevelMap }) => compat !== undefined || thinkingLevelMap !== undefined,
          )
        ) {
          if (
            !(await confirmAction(
              'Changing API protocol clears model compatibility and thinking-level settings. Other model settings are kept.',
              { title: 'Change API protocol', confirmLabel: 'Save changes', signal },
            ))
          )
            return;
          models = models.map(({ compat: _compat, thinkingLevelMap: _mapping, ...model }) => model);
        }
        const { id: saved } = await browserRequest<{ id: string }>(ctx, '/providers', {
          ...payload('PUT', {
            id: id.value.trim(),
            create: custom && !provider,
            name: custom ? name.value.trim() : undefined,
            api: custom ? api.value : undefined,
            baseUrl: endpoint.value.trim(),
            key: key.value.trim(),
            models,
          }),
          signal,
        });
        if (!signal.aborted) actions.saved(saved);
      }, true);
    };
  }

  if (provider) {
    renderDraft(provider, provider.custom);
  } else {
    const mode = fromMarkup(`<fieldset class="provider-mode" aria-label="Provider type">
      <label class="ui-button"><input type="radio" name="provider-type" value="builtin" checked>Built-in provider</label>
      <label class="ui-button"><input type="radio" name="provider-type" value="custom">Custom API</label>
    </fieldset>`);
    const picker = fromMarkup<HTMLSelectElement>(
      '<select data-initial-focus><option value="">Choose a provider</option></select>',
    );
    for (const item of [...available].sort((a, b) => a.name.localeCompare(b.name))) {
      picker.add(new Option(item.name, item.id));
    }
    const selection = field('Provider', picker);
    controls.prepend(mode, selection);
    function select() {
      const custom = required(mode.querySelector<HTMLInputElement>(':checked')).value === 'custom';
      selection.hidden = picker.disabled = custom;
      renderDraft(custom ? undefined : available.find(({ id }) => id === picker.value), custom);
    }
    mode.onchange = picker.onchange = select;
    select();
  }
  return form;
}
