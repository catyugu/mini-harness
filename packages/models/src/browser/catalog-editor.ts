import {
  button,
  dialog,
  field,
  fromMarkup,
  iconButton,
  required,
  toggle,
} from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import { maxModelTokens, modelDefaults, type ProviderModelDefinition } from '../shared/pi-provider.ts';

export function catalogEditor() {
  const root = fromMarkup(`<section class="model-catalog-editor">
    <div class="model-catalog-heading"><h3>Model catalog</h3><div class="ui-actions"></div></div>
    <div class="model-catalog-rows"></div>
  </section>`);
  const actions = required(root.querySelector('.ui-actions'));
  const list = required(root.querySelector('.model-catalog-rows'));
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
    const node = fromMarkup(`<div class="model-catalog-model" role="group" aria-label="Model">
      <div class="model-catalog-row">
        <input class="ui-input" aria-label="Model ID" placeholder="Model ID" maxlength="160" required>
        <input class="ui-input model-catalog-name" aria-label="Display name" placeholder="Display name" maxlength="160">
      </div>
      <div class="model-catalog-advanced" hidden>
        <div class="model-catalog-grid">
          <label class="ui-field">Context window<input type="number" min="1" max="${maxModelTokens}" required></label>
          <label class="ui-field">Max output tokens<input type="number" min="1" max="${maxModelTokens}" required></label>
        </div>
        <div class="model-catalog-capabilities">
          <span>Input types</span>
          <label><input type="checkbox"> Text</label>
          <label><input type="checkbox"> Image</label>
        </div>
      </div>
    </div>`);
    const [id, name, context, tokens, text, image] = node.querySelectorAll('input');
    const advanced = required(node.querySelector<HTMLElement>('.model-catalog-advanced'));
    const row = required(node.querySelector('.model-catalog-row'));
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
    const handle = fromMarkup(
      '<span class="model-catalog-drag" title="Drag to reorder" aria-label="Drag to reorder"></span>',
    );
    handle.append(icon({ path: 'M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01' }));
    let target: HTMLElement | undefined;
    function clearTarget() {
      if (target) delete target.dataset.drop;
      target = undefined;
    }
    handle.onpointerdown = (event) => {
      if (!event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      node.dataset.dragging = '';
    };
    handle.onpointermove = (event) => {
      if (!handle.hasPointerCapture(event.pointerId)) return;
      clearTarget();
      const candidate = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest<HTMLElement>('.model-catalog-model');
      if (!candidate || candidate === node || candidate.parentElement !== list) return;
      target = candidate;
      const rect = candidate.getBoundingClientRect();
      target.dataset.drop = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    };
    handle.onpointerup = () => {
      if (!target || node.closest('fieldset')?.disabled) return;
      const destination = target;
      const before = destination.dataset.drop === 'before';
      clearTarget();
      delete node.dataset.dragging;
      if (before) destination.before(node);
      else destination.after(node);
      customized = true;
    };
    handle.onlostpointercapture = () => {
      clearTarget();
      delete node.dataset.dragging;
    };
    row.prepend(handle);
    expand.setAttribute('aria-expanded', 'false');
    expand.onclick = () => {
      advanced.hidden = !advanced.hidden;
      expand.setAttribute('aria-expanded', String(!advanced.hidden));
    };
    node.addEventListener(
      'invalid',
      () => {
        if (advanced.hidden) expand.click();
      },
      true,
    );
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
    if (!model) {
      customized = true;
      expand.click();
      id.focus();
    }
  }

  add.onclick = () => addRow();

  return {
    root,
    actions,
    value: () => (customized ? models() : undefined),
    reset(initial: readonly ProviderModelDefinition[], override: boolean) {
      list.replaceChildren();
      customized = override;
      initial.forEach(addRow);
    },
    async select(found: readonly ProviderModelDefinition[], signal: AbortSignal) {
      const existing = new Set(
        models()
          .map(({ id }) => id)
          .filter(Boolean),
      );
      const selected = await selectDiscovered(found, existing, signal);
      if (!selected) return;
      const listed = new Set(found.map(({ id }) => id));
      const picked = new Set(selected.map(({ id }) => id));
      for (const node of [...list.children]) {
        const { id } = required(readers.get(node))();
        if (listed.has(id) && !picked.has(id)) removeRow(node);
      }
      for (const model of selected) {
        if (existing.has(model.id)) continue;
        addRow(model);
        existing.add(model.id);
        customized = true;
      }
    },
  };
}

function selectDiscovered(
  models: readonly ProviderModelDefinition[],
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
  cancel.onclick = () => modal.close();
  apply.onclick = () => modal.close('apply');
  return new Promise<ProviderModelDefinition[] | undefined>((resolve) => {
    const abort = () => modal.close();
    signal.addEventListener('abort', abort, { once: true });
    modal.addEventListener(
      'close',
      () => {
        signal.removeEventListener('abort', abort);
        modal.remove();
        resolve(
          !signal.aborted && modal.returnValue === 'apply'
            ? choices.filter(({ check }) => check.checked).map(({ model }) => model)
            : undefined,
        );
      },
      { once: true },
    );
    update();
    document.body.append(modal);
    modal.showModal();
    search.focus();
  });
}
