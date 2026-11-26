import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/models/browser/api';
import { button, field, toggle } from '@mini-harness/ui-primitives/primitives';
import type { ContextSettings } from '../shared/state.ts';

export function settingsForm(
  ctx: Context,
  signal: AbortSignal,
  write: (value: ContextSettings) => Promise<void>,
) {
  const node = document.createElement('section');
  node.className = 'context-settings';
  const heading = document.createElement('h4');
  heading.textContent = 'Context Management';
  const auto = toggle('Auto compaction', true);
  const model = document.createElement('select');
  model.setAttribute('aria-label', 'Summary model');
  const save = button('Apply', 'primary');
  const error = document.createElement('p');
  error.className = 'hint form-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const ratios = ([
    ['triggerRatio', 'Trigger threshold (%)'],
    ['targetRatio', 'Target threshold (%)'],
    ['retainRatio', 'Retain ratio (%)'],
  ] as const).map(([key, label]) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.1';
    input.max = '99.9';
    input.step = '0.1';
    input.setAttribute('aria-label', label);
    return { key, input, row: field(label, input) };
  });
  const fields = document.createElement('fieldset');
  fields.className = 'context-fields';
  fields.append(field('Auto compaction', auto), ...ratios.map(({ row }) => row), field('Summary model', model), save);
  node.append(heading, fields, error);
  let current: ContextSettings;
  let editable = true;
  let busy = false;
  function renderModels() {
    const selected = model.value || JSON.stringify(current?.summaryModel ?? null);
    const { models, providers } = ctx.miniModels.get();
    const names = new Map(providers.map(({ id, name }) => [id, name]));
    model.replaceChildren(new Option('Current model', 'null'));
    for (const entry of models.filter(({ configured }) => configured)) {
      model.add(new Option((names.get(entry.provider) ?? entry.provider) + ' / ' + entry.name, JSON.stringify({ provider: entry.provider, id: entry.id })));
    }
    if (!Array.from(model.options).some(({ value }) => value === selected))
      model.add(new Option('Unavailable model', selected));
    model.value = selected;
  }
  ctx.miniModels.subscribe(renderModels, signal);
  save.onclick = async () => {
    busy = true;
    fields.disabled = true;
    error.hidden = true;
    try {
      await write({
        autoCompact: auto.checked,
        triggerRatio: ratios[0].input.valueAsNumber / 100,
        targetRatio: ratios[1].input.valueAsNumber / 100,
        retainRatio: ratios[2].input.valueAsNumber / 100,
        summaryModel: JSON.parse(model.value),
      });
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
    } finally {
      busy = false;
      fields.disabled = !editable;
    }
  };
  return {
    node,
    update(next: ContextSettings, enabled = true) {
      editable = enabled;
      fields.disabled = busy || !enabled;
      if (current && JSON.stringify(current) === JSON.stringify(next)) return;
      current = next;
      auto.checked = next.autoCompact;
      for (const { key, input } of ratios) input.value = String(Number((next[key] * 100).toFixed(4)));
      model.value = '';
      renderModels();
    },
  };
}
