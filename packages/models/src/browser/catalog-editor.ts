import {
  button,
  dialog,
  field,
  fromMarkup,
  iconButton,
  required,
  toggle,
} from '@mini-harness/ui-primitives/primitives';
import { maxModelTokens, modelDefaults, type ProviderModelDefinition } from '../shared/pi-provider.ts';
import type { ProviderModel } from '../shared/catalog.ts';

export function catalogEditor() {
  const root = fromMarkup(`<section class="catalog-editor">
    <div class="catalog-heading"><h3>Model catalog</h3><div class="ui-actions"></div></div>
    <div class="catalog-rows"></div>
  </section>`);
  const actions = required(root.querySelector('.ui-actions'));
  const list = required(root.querySelector('.catalog-rows'));
  const add = button('Add model', 'quiet');
  root.append(add);
  const readers = new WeakMap<Element, () => ProviderModelDefinition>();
  const models = () => [...list.children].map((node) => required(readers.get(node))());
  let customized = false;

  function removeRow(node: Element) {
    node.remove();
    customized = true;
  }

  function addRow(model?: ProviderModelDefinition) {
    const node = fromMarkup(`<div class="catalog-model" role="group" aria-label="Model">
      <div class="catalog-row">
        <input class="ui-input" aria-label="Model ID" placeholder="Model ID" maxlength="160" required>
        <input class="ui-input catalog-name" aria-label="Display name" placeholder="Display name" maxlength="160">
      </div>
      <div class="catalog-advanced" hidden>
        <div class="catalog-grid">
          <label class="ui-field">Context window<input type="number" min="1" max="${maxModelTokens}" required></label>
          <label class="ui-field">Max output tokens<input type="number" min="1" max="${maxModelTokens}" required></label>
        </div>
        <div class="catalog-capabilities">
          <span>Input types</span>
          <label><input type="checkbox"> Text</label>
          <label><input type="checkbox"> Image</label>
        </div>
      </div>
    </div>`);
    const [id, name, context, tokens, text, image] = node.querySelectorAll('input');
    const advanced = required(node.querySelector<HTMLElement>('.catalog-advanced'));
    const row = required(node.querySelector('.catalog-row'));
    const reasoning = toggle('Reasoning', model?.reasoning ?? false);
    advanced.append(field('Reasoning', reasoning, 'compact'));
    id.value = model?.id ?? '';
    name.value = model?.name ?? '';
    context.valueAsNumber = model?.contextWindow ?? modelDefaults.contextWindow;
    tokens.valueAsNumber = model?.maxTokens ?? modelDefaults.maxTokens;
    text.checked = model ? model.input.includes('text') : true;
    image.checked = model?.input.includes('image') ?? false;
    readers.set(node, () => ({
      ...model,
      id: id.value.trim(),
      name: name.value.trim() || id.value.trim(),
      contextWindow: context.valueAsNumber,
      maxTokens: tokens.valueAsNumber,
      input: [...(text.checked ? ['text' as const] : []), ...(image.checked ? ['image' as const] : [])],
      reasoning: reasoning.checked,
    }));
    const expand = iconButton('Advanced model settings', 'chevron');
    const remove = iconButton('Remove model', 'trash');
    function move(up: boolean) {
      const neighbor = up ? node.previousElementSibling : node.nextElementSibling;
      if (!neighbor) return;
      if (up) neighbor.before(node);
      else neighbor.after(node);
      customized = true;
    }
    const up = iconButton('Move model up', 'chevron', 'catalog-up');
    const down = iconButton('Move model down', 'chevron', 'catalog-down');
    up.onclick = () => {
      move(true);
      up.focus();
    };
    down.onclick = () => {
      move(false);
      down.focus();
    };
    const order = fromMarkup('<div class="ui-actions catalog-order"></div>');
    order.append(up, down);
    advanced.append(order);
    expand.setAttribute('aria-expanded', 'false');
    expand.onclick = () => {
      advanced.hidden = !advanced.hidden;
      expand.setAttribute('aria-expanded', String(!advanced.hidden));
    };
    remove.onclick = () => {
      const next = node.nextElementSibling ?? node.previousElementSibling;
      removeRow(node);
      (next?.querySelector('input') ?? add).focus();
    };
    row.append(expand, remove);
    node.oninput = () => {
      customized = true;
    };
    list.append(node);
    return { id, expand };
  }

  add.onclick = () => {
    customized = true;
    const { id, expand } = addRow();
    expand.click();
    id.focus();
  };

  return {
    root,
    actions,
    models,
    customized: () => customized,
    reset(initial: readonly ProviderModelDefinition[], override: boolean) {
      list.replaceChildren();
      customized = override;
      initial.forEach(addRow);
    },
    reveal(control: HTMLElement) {
      const node = control.closest('.catalog-model');
      node?.querySelector<HTMLButtonElement>('[aria-expanded="false"]')?.click();
    },
    applySelection(found: readonly ProviderModel[], selected: readonly ProviderModel[]) {
      const listed = new Set(found.map(({ id }) => id));
      const picked = new Set(selected.map(({ id }) => id));
      for (const node of [...list.children]) {
        const { id } = required(readers.get(node))();
        if (listed.has(id) && !picked.has(id)) removeRow(node);
      }
      const existing = new Set(models().map(({ id }) => id));
      for (const model of selected) {
        if (existing.has(model.id)) continue;
        addRow(model);
        existing.add(model.id);
        customized = true;
      }
    },
  };
}

export function selectDiscovered(
  models: readonly ProviderModel[],
  existing: ReadonlySet<string>,
  signal: AbortSignal,
) {
  if (signal.aborted) return Promise.resolve(undefined);
  const content = fromMarkup(`<div class="discovery-picker">
    <label class="ui-field">Search models<input type="search" autocomplete="off"></label>
    <label class="discovery-all"><input type="checkbox"> Select all</label>
    <div class="discovery-list"></div>
    <footer class="ui-actions"></footer>
  </div>`);
  const search = required(content.querySelector<HTMLInputElement>('[type="search"]'));
  const all = required(content.querySelector<HTMLInputElement>('.discovery-all input'));
  const list = required(content.querySelector('.discovery-list'));
  const cancel = button('Cancel', 'quiet');
  const apply = button('Apply selection', 'primary');
  required(content.querySelector('footer')).append(cancel, apply);
  const modal = dialog('Select models', content);
  const choices = models.map((model) => {
    const check = fromMarkup<HTMLInputElement>('<input type="checkbox">');
    check.checked = !existing.size || existing.has(model.id);
    const label = field(model.id, check, 'compact');
    label.title = model.name;
    list.append(label);
    return { label, model, check };
  });
  function update() {
    const query = search.value.trim().toLowerCase();
    const visible = choices.filter(({ label, model }) => {
      label.hidden = ![model.id, model.name].some((value) => value.toLowerCase().includes(query));
      return !label.hidden;
    });
    const count = visible.filter(({ check }) => check.checked).length;
    all.disabled = !visible.length;
    all.checked = visible.length > 0 && count === visible.length;
    all.indeterminate = count > 0 && count < visible.length;
  }
  all.onchange = () => {
    for (const { label, check } of choices) if (!label.hidden) check.checked = all.checked;
    update();
  };
  search.oninput = update;
  list.addEventListener('change', update);
  let selected: ProviderModel[] | undefined;
  cancel.onclick = () => modal.close();
  apply.onclick = () => {
    selected = choices.filter(({ check }) => check.checked).map(({ model }) => model);
    modal.close();
  };
  return new Promise<ProviderModel[] | undefined>((resolve) => {
    const abort = () => modal.close();
    signal.addEventListener('abort', abort, { once: true });
    modal.addEventListener(
      'close',
      () => {
        signal.removeEventListener('abort', abort);
        modal.remove();
        resolve(signal.aborted ? undefined : selected);
      },
      { once: true },
    );
    update();
    document.body.append(modal);
    modal.showModal();
    search.focus();
  });
}
