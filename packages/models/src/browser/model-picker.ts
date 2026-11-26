import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import { bindPopover, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import type { ModelSummary } from '../shared/catalog.ts';

let nextPicker = 0;

export function createModelPicker(
  button: HTMLButtonElement,
  onSelect: (model: ModelChoice) => void,
  signal: AbortSignal,
  emptyLabel = 'Choose model',
) {
  const id = 'model-options-' + ++nextPicker;
  const popup = fromMarkup(`<div class="ui-popover model-picker" popover="auto">
      <input class="model-search" type="search" role="combobox" aria-label="Search models"
        aria-controls="${id}" aria-autocomplete="list" aria-expanded="true" placeholder="Search models">
      <div id="${id}" class="model-results" role="listbox" aria-label="Configured models"></div>
      <p class="model-empty hint" role="status" hidden></p>
    </div>`);
  button.after(popup);
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', id);
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

  const position = bindPopover(button, popup, signal, {
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

  function render() {
    const terms = search.value.trim().toLowerCase().split(/\s+/);
    const groups = new Map<string, HTMLElement>();
    results.replaceChildren();
    options = [];
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
      const option = document.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.className = 'suggestion model-option';
      option.id = id + '-' + options.length;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(model === selected));
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
      option.onpointermove = () => highlight(options.indexOf(option), false);
      option.onclick = () => {
        popup.hidePopover();
        button.focus();
        onSelect({ provider: model.provider, id: model.id });
      };
      options.push(option);
      group.append(option);
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
    if (button.disabled || popup.matches(':popover-open')) return;
    search.value = '';
    render();
    popup.showPopover();
    position();
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
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      popup.hidePopover();
      button.focus();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      options[cursor]?.click();
    } else if (options.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      highlight((cursor + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    }
  };
  return {
    open,
    selected: () => selected,
    update(catalog: ModelSummary[], names: { id: string; name: string }[], choice: ModelChoice) {
      providers = new Map(names.map(({ id, name }) => [id, name]));
      models = catalog
        .filter((model) => model.configured)
        .sort(
          (a, b) =>
            providerName(a.provider).localeCompare(providerName(b.provider)) ||
            a.provider.localeCompare(b.provider) ||
            a.name.localeCompare(b.name),
        );
      selected = models.find(
        (model) => model.provider === choice.provider && (!choice.id || model.id === choice.id),
      );
      const label = document.createElement('span');
      label.textContent = selected?.name ?? emptyLabel;
      button.replaceChildren(label, icon('chevron'));
      button.title = selected ? providerName(selected.provider) + ' / ' + selected.id : '';
      button.setAttribute('aria-label', selected ? 'Model: ' + selected.name : emptyLabel);
      if (popup.matches(':popover-open')) render();
      return selected;
    },
  };
}
