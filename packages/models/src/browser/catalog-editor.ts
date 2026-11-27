import { button, dialog, field, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
import { maxModelTokens, modelDefaults, type ProviderModel } from '../shared/catalog.ts';

type ModelDraft = ProviderModel & { sourceId?: string };
type ModelRow = {
  node: HTMLDetailsElement;
  read(): ModelDraft;
  up: HTMLButtonElement;
  down: HTMLButtonElement;
};

export function catalogEditor() {
  const root = fromMarkup(`<section class="catalog-editor">
    <div class="catalog-heading"><h3>Model catalog</h3><div class="ui-actions"></div></div>
    <p class="hint catalog-empty">No models in this catalog.</p>
    <div class="catalog-rows"></div>
  </section>`);
  const actions = required(root.querySelector('.ui-actions'));
  const empty = required(root.querySelector<HTMLElement>('.catalog-empty'));
  const list = required(root.querySelector('.catalog-rows'));
  const add = button('Add model', 'quiet');
  root.append(add);
  let rows: ModelRow[] = [];
  let customized = false;

  function update() {
    empty.hidden = rows.length > 0;
    rows.forEach(({ up, down }, index) => {
      up.disabled = index === 0;
      down.disabled = index === rows.length - 1;
    });
  }

  function addRow(model?: ProviderModel, sourceId?: string) {
    const node = fromMarkup<HTMLDetailsElement>(`<details class="catalog-model">
      <summary><strong></strong><small></small></summary>
      <div class="catalog-model-fields">
        <div class="catalog-grid">
          <label class="ui-field">Model ID<input maxlength="160" required></label>
          <label class="ui-field">Display name<input maxlength="160"></label>
          <label class="ui-field">Context window<input type="number" min="1" max="${maxModelTokens}" required></label>
          <label class="ui-field">Max output tokens<input type="number" min="1" max="${maxModelTokens}" required></label>
        </div>
        <div class="catalog-capabilities">
          <label><input type="checkbox"> Text input</label>
          <label><input type="checkbox"> Image input</label>
          <label><input type="checkbox"> Reasoning</label>
        </div>
        <div class="ui-actions"></div>
      </div>
    </details>`);
    const [id, name, context, tokens, text, image, reasoning] = node.querySelectorAll('input');
    id.value = model?.id ?? '';
    name.value = model?.name ?? '';
    context.valueAsNumber = model?.contextWindow ?? modelDefaults.contextWindow;
    tokens.valueAsNumber = model?.maxTokens ?? modelDefaults.maxTokens;
    text.checked = model ? model.input.includes('text') : true;
    image.checked = model?.input.includes('image') ?? false;
    reasoning.checked = model?.reasoning ?? false;
    const read = (): ModelDraft => ({
      sourceId,
      id: id.value.trim(),
      name: name.value.trim() || id.value.trim(),
      contextWindow: context.valueAsNumber,
      maxTokens: tokens.valueAsNumber,
      input: [...(text.checked ? ['text' as const] : []), ...(image.checked ? ['image' as const] : [])],
      reasoning: reasoning.checked,
    });
    const headline = required(node.querySelector('strong'));
    const subtitle = required(node.querySelector('small'));
    function label() {
      const model = read();
      headline.textContent = model.id || 'New model';
      headline.title = model.id;
      subtitle.textContent = model.name !== model.id ? model.name : '';
      subtitle.title = subtitle.textContent;
    }
    label();
    node.oninput = () => {
      customized = true;
      label();
    };
    const up = button('Move up', 'quiet');
    const down = button('Move down', 'quiet');
    const remove = button('Remove model', 'quiet');
    const row = { node, read, up, down };
    function move(delta: number) {
      const index = rows.indexOf(row);
      const other = rows[index + delta];
      rows.splice(index, 1);
      rows.splice(index + delta, 0, row);
      if (delta < 0) other.node.before(node);
      else other.node.after(node);
      customized = true;
      update();
      (delta < 0 ? (up.disabled ? down : up) : down.disabled ? up : down).focus();
    }
    up.onclick = () => move(-1);
    down.onclick = () => move(1);
    remove.onclick = () => {
      const index = rows.indexOf(row);
      rows.splice(index, 1);
      customized = true;
      node.remove();
      update();
      (rows[index]?.node.querySelector('summary') ?? add).focus();
    };
    required(node.querySelector('.ui-actions')).append(up, down, remove);
    rows.push(row);
    list.append(node);
    return { node, id };
  }

  add.onclick = () => {
    customized = true;
    const { node, id } = addRow();
    node.open = true;
    update();
    id.focus();
  };
  return {
    root,
    actions,
    reset(models: readonly ProviderModel[], customizedCatalog: boolean) {
      rows = [];
      list.replaceChildren();
      customized = customizedCatalog;
      for (const model of models) addRow(model, model.id);
      update();
    },
    models: () => rows.map(({ read }) => read()),
    customized: () => customized,
    append(models: readonly ProviderModel[]) {
      const existing = new Set(rows.map(({ read }) => read().id));
      for (const model of models) {
        if (existing.has(model.id)) continue;
        existing.add(model.id);
        addRow(model);
        customized = true;
      }
      update();
    },
  };
}

export function selectDiscovered(
  models: readonly ProviderModel[],
  existing: ReadonlySet<string>,
  signal: AbortSignal,
  accept: (models: ProviderModel[]) => void,
) {
  const content = fromMarkup(`<div class="discovery-picker">
    <p class="hint">Select the models to add to this provider.</p>
    <label class="ui-field">Search models<input type="search" autocomplete="off"></label>
    <label class="discovery-all"><input type="checkbox"> Select all</label>
    <div class="discovery-list"></div>
    <footer class="ui-actions"><output aria-live="polite"></output></footer>
  </div>`);
  const search = required(content.querySelector<HTMLInputElement>('[type="search"]'));
  const all = required(content.querySelector<HTMLInputElement>('.discovery-all input'));
  const list = required(content.querySelector('.discovery-list'));
  const footer = required(content.querySelector('footer'));
  const count = required(footer.querySelector('output'));
  const cancel = button('Cancel', 'quiet');
  const add = button('Add selected', 'primary');
  footer.append(cancel, add);
  const modal = dialog('Select models', content);
  const choices = models.map((model) => {
    const check = fromMarkup<HTMLInputElement>('<input type="checkbox">');
    check.checked = existing.has(model.id);
    const label = field(model.id, check, 'compact');
    label.title = model.name;
    label.classList.add('discovery-choice');
    list.append(label);
    return { label, model, check };
  });
  function update() {
    const query = search.value.trim().toLowerCase();
    const shown = choices.filter(({ label, model }) => {
      const match = [model.id, model.name].some((value) => value.toLowerCase().includes(query));
      label.hidden = !match;
      return match;
    });
    const marked = shown.filter(({ check }) => check.checked).length;
    all.disabled = shown.length === 0;
    all.checked = shown.length > 0 && marked === shown.length;
    all.indeterminate = marked > 0 && marked < shown.length;
    const total = choices.filter(({ check }) => check.checked).length;
    count.value = total + ' selected';
    add.disabled = total === 0;
  }
  all.onchange = () => {
    for (const { label, check } of choices) if (!label.hidden) check.checked = all.checked;
    update();
  };
  search.oninput = update;
  list.addEventListener('change', update);
  cancel.onclick = () => modal.close();
  add.onclick = () => {
    accept(choices.filter(({ check }) => check.checked).map(({ model }) => model));
    modal.close();
  };
  return new Promise<void>((resolve) => {
    const dispose = () => {
      modal.remove();
      signal.removeEventListener('abort', dispose);
      resolve();
    };
    modal.addEventListener('close', dispose, { once: true });
    signal.addEventListener('abort', dispose, { once: true });
    update();
    document.body.append(modal);
    modal.showModal();
    search.focus();
  });
}
