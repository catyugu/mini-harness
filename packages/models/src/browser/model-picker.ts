import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import {
  bindPopover,
  button as createButton,
  fromMarkup,
  required,
} from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import type { Context } from 'mini-harness/cordis';
import type { ModelPicker, ModelPickerOptions } from './api.ts';
import type { ModelSummary } from '../shared/catalog.ts';

let nextPicker = 0;

export function createModelPicker(
  catalog: Pick<Context['miniModels'], 'get' | 'subscribe'>,
  onSelect: (model: ModelChoice) => void,
  signal: AbortSignal,
  { emptyLabel = 'Choose model', selectEmpty, label: accessibleLabel, variant }: ModelPickerOptions = {},
): ModelPicker {
  const node = document.createElement('div');
  node.className = 'model-picker-control';
  const button = createButton('', variant);
  button.classList.add('model-select');
  const caption = document.createElement('span');
  caption.className = 'ui-truncate';
  button.append(caption, icon('chevron'));
  const id = 'model-options-' + ++nextPicker;
  const popup = fromMarkup(`<div class="ui-popover model-picker" popover="auto">
      <input class="model-search" type="search" role="combobox" aria-label="Search models"
        aria-controls="${id}" aria-autocomplete="list" aria-expanded="true" placeholder="Search models">
      <div id="${id}" class="model-results" role="listbox" aria-label="Configured models"></div>
      <p class="model-empty hint" role="status" hidden></p>
    </div>`);
  node.append(button, popup);
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  popup.id = id + '-picker';
  button.setAttribute('aria-controls', popup.id);
  const search = required(popup.querySelector<HTMLInputElement>('.model-search'));
  const results = required(popup.querySelector<HTMLElement>('.model-results'));
  const empty = required(popup.querySelector<HTMLElement>('.model-empty'));
  let models: ModelSummary[] = [];
  let providers = new Map<string, string>();
  let selected: ModelSummary | undefined;
  let options: HTMLButtonElement[] = [];
  let cursor = -1;

  function providerName(id: string) {
    return providers.get(id) ?? id;
  }

  const show = bindPopover(button, popup, signal, {
    width: 300,
    maxHeight: 420,
    align: 'end',
    prefer: 'above',
  });

  function matches(label: string, term: string) {
    if (label.includes(term)) return true;
    if (term.length < 3) return false;
    let index = 0;
    for (const character of label) {
      if (term[index] === character && ++index === term.length) return true;
    }
    return false;
  }

  function highlight(index: number, scroll = true) {
    options[cursor]?.classList.remove('highlighted');
    cursor = index;
    const active = options[index];
    if (!active) {
      search.removeAttribute('aria-activedescendant');
      return;
    }
    active.classList.add('highlighted');
    search.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  }

  function addOption(parent: HTMLElement, active: boolean, select: () => void) {
    const option = document.createElement('button');
    option.type = 'button';
    option.tabIndex = -1;
    option.className = 'ui-option model-option';
    option.id = id + '-' + options.length;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(active));
    option.onpointermove = () => highlight(options.indexOf(option), false);
    option.onclick = () => {
      popup.hidePopover();
      button.focus();
      select();
    };
    options.push(option);
    parent.append(option);
    return option;
  }

  function render() {
    const terms = search.value.trim().toLowerCase().split(/\s+/);
    const groups = new Map<string, HTMLElement>();
    results.replaceChildren();
    options = [];
    if (selectEmpty && terms.every((term) => matches(emptyLabel.toLowerCase(), term)))
      addOption(results, current === null, selectEmpty).textContent = emptyLabel;
    for (const model of models) {
      const provider = providerName(model.provider);
      const labels = [model.name, model.id, provider, model.provider].map((label) => label.toLowerCase());
      if (!terms.every((term) => labels.some((label) => matches(label, term)))) continue;
      let group = groups.get(model.provider);
      if (!group) {
        group = document.createElement('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', provider);
        const title = document.createElement('div');
        title.className = 'model-provider';
        title.setAttribute('aria-hidden', 'true');
        title.textContent = provider;
        group.append(title);
        results.append(group);
        groups.set(model.provider, group);
      }
      const option = addOption(group, model === selected, () =>
        onSelect({ provider: model.provider, id: model.id }),
      );
      const label = document.createElement('span');
      label.className = 'model-option-label';
      const name = document.createElement('strong');
      name.textContent = model.name;
      label.append(name);
      if (model.id !== model.name) {
        const id = document.createElement('small');
        id.textContent = model.id;
        label.append(id);
      }
      const modality = document.createElement('small');
      modality.textContent = model.input.includes('image') ? 'Text and images' : 'Text only';
      label.append(modality);
      option.append(label);
    }
    empty.textContent = models.length
      ? 'No matching models.'
      : 'Configure a provider in Settings to use a model.';
    empty.hidden = options.length > 0;
    cursor = -1;
    const selectedIndex = search.value.trim()
      ? -1
      : options.findIndex((option) => option.getAttribute('aria-selected') === 'true');
    highlight(options.length ? Math.max(0, selectedIndex) : -1, false);
  }

  function open() {
    if (
      !button.getClientRects().length ||
      getComputedStyle(button).visibility === 'hidden' ||
      button.matches(':disabled') ||
      popup.matches(':popover-open')
    )
      return;
    search.value = '';
    render();
    show();
    search.focus();
    options[cursor]?.scrollIntoView({ block: 'nearest' });
  }

  button.onclick = () => {
    if (popup.matches(':popover-open')) popup.hidePopover();
    else open();
  };
  search.oninput = render;
  search.onkeydown = (event) => {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      options[cursor]?.click();
    } else if (options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      highlight((cursor + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    }
  };
  let current: ModelChoice | null = null;
  function refreshCatalog() {
    const { models: available, providers: names } = catalog.get();
    providers = new Map(names.map(({ id, name }) => [id, name]));
    models = available
      .filter((model) => model.configured)
      .sort(
        (a, b) =>
          providerName(a.provider).localeCompare(providerName(b.provider)) ||
          a.provider.localeCompare(b.provider) ||
          a.name.localeCompare(b.name),
      );
    refreshSelection();
  }
  function refreshSelection() {
    const choice = current;
    selected =
      choice === null
        ? undefined
        : models.find(
            (model) => model.provider === choice.provider && model.id === choice.id,
          );
    caption.textContent = selected?.name ?? (choice?.id || emptyLabel);
    button.title = selected ? providerName(selected.provider) + ' / ' + selected.id : '';
    button.setAttribute('aria-label', accessibleLabel ?? (selected ? 'Model: ' + selected.name : emptyLabel));
    if (popup.matches(':popover-open')) render();
  }

  catalog.subscribe(refreshCatalog, signal);
  refreshCatalog();
  return {
    node,
    open,
    selected: () => selected,
    update(next) {
      if (next?.provider !== current?.provider || next?.id !== current?.id) {
        current = next;
        refreshSelection();
      }
      return selected ?? undefined;
    },
  };
}
