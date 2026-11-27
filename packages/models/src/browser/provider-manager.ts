import type { Context } from 'mini-harness/cordis';
import { browserRequest, payload } from '@mini-harness/ui-runtime/http';
import {
  button,
  confirmAction,
  fromMarkup,
  iconButton,
  required,
} from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import type { ProviderInfo, ProtocolInfo } from '../shared/pi-provider.ts';
import { providerEditor } from './provider-editor.ts';

const listed = ({
  configured,
  storedCredential,
  custom,
  endpointCustomized,
  modelsCustomized,
}: ProviderInfo) => configured || storedCredential || custom || endpointCustomized || modelsCustomized;

export function providerManager(
  ctx: Context,
  snapshot: () => { providers: ProviderInfo[]; protocols: ProtocolInfo[]; canManageProviders: boolean },
  signal: AbortSignal,
) {
  const content = fromMarkup(`<div class="model-settings">
    <div class="provider-list"></div>
    <div class="provider-add"></div>
    <p class="hint provider-status" role="status"></p>
  </div>`);
  const list = required(content.querySelector('.provider-list'));
  const addArea = required(content.querySelector<HTMLElement>('.provider-add'));
  const status = required(content.querySelector('[role="status"]'));
  const add = button('Add provider', 'quiet');
  add.prepend(icon('plus'));
  addArea.append(add);
  let active: { form: HTMLFormElement; controller: AbortController } | undefined;
  let focusProvider: string | undefined;

  function closeEditor() {
    active?.controller.abort();
    active?.form.remove();
    active = undefined;
    add.hidden = false;
  }

  function edit(mount: Element, provider?: ProviderInfo) {
    closeEditor();
    status.textContent = '';
    const controller = new AbortController();
    const lifetime = AbortSignal.any([signal, controller.signal]);
    const { providers, protocols } = snapshot();
    const form = providerEditor(
      ctx,
      providers.filter((item) => !listed(item)),
      provider,
      protocols,
      lifetime,
      {
        cancel() {
          closeEditor();
          focusProvider = provider?.id;
          render();
          if (!provider) add.focus();
        },
        saved(id) {
          closeEditor();
          status.textContent = 'Provider saved.';
          focusProvider = id;
          render();
        },
      },
    );
    active = { form, controller };
    add.hidden = !provider;
    mount.append(form);
    form.querySelector<HTMLElement>('[data-initial-focus]:not([disabled])')?.focus();
  }

  function render() {
    if (signal.aborted) return;
    const { providers, canManageProviders } = snapshot();
    addArea.hidden = !canManageProviders;
    if (!canManageProviders) {
      closeEditor();
      status.textContent = '';
      list.replaceChildren(fromMarkup('<p class="hint">Models are provided by plugins.</p>'));
      return;
    }
    if (active) return;
    list.replaceChildren(
      ...providers
        .filter(listed)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((provider) => {
          const card = fromMarkup(`<article class="ui-card provider-card">
          <div class="provider-row"><div><strong></strong><small class="provider-state"></small></div><div class="ui-actions"></div></div>
        </article>`);
          required(card.querySelector('strong')).textContent = provider.name;
          const summary = required(card.querySelector<HTMLElement>('.provider-state'));
          const count = provider.models.length;
          summary.textContent = provider.configured
            ? count + (count === 1 ? ' model' : ' models')
            : provider.canSetKey
              ? 'API key needed'
              : 'Authentication required';
          const actions = required(card.querySelector('.ui-actions'));
          const editButton = button('Edit', 'quiet');
          editButton.setAttribute('aria-label', 'Edit ' + provider.name);
          editButton.dataset.provider = provider.id;
          editButton.onclick = () => edit(card, provider);
          actions.append(editButton);
          if (
            provider.custom ||
            provider.storedCredential ||
            provider.endpointCustomized ||
            provider.modelsCustomized
          ) {
            const remove = iconButton('Remove ' + provider.name, 'trash');
            remove.onclick = async () => {
              if (
                !(await confirmAction(
                  provider.custom
                    ? 'Remove ' + provider.name + ' and its model catalog?'
                    : 'Clear saved settings and credentials for ' + provider.name + '?',
                  { title: 'Remove provider', confirmLabel: 'Remove', signal },
                ))
              )
                return;
              remove.disabled = true;
              try {
                await browserRequest(ctx, '/providers', {
                  ...payload('DELETE', { id: provider.id }),
                  signal,
                });
                status.textContent = 'Provider removed.';
                add.focus();
              } catch (error) {
                if (!signal.aborted)
                  status.textContent = error instanceof Error ? error.message : String(error);
              } finally {
                remove.disabled = false;
              }
            };
            actions.append(remove);
          }
          return card;
        }),
    );
    if (!list.children.length)
      list.append(
        fromMarkup('<p class="hint">Add a provider to make its models available in the composer.</p>'),
      );
    if (focusProvider) {
      const control = list.querySelector<HTMLButtonElement>(
        '[data-provider="' + CSS.escape(focusProvider) + '"]',
      );
      if (control) {
        focusProvider = undefined;
        control.focus();
      }
    }
  }

  add.onclick = () => edit(addArea);
  render();
  return {
    content,
    render,
    reset() {
      closeEditor();
      focusProvider = undefined;
      status.textContent = '';
      render();
    },
  };
}
