import type { Context } from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type {} from '@mini-harness/models/browser/api';
import { createModelPicker } from '@mini-harness/models/browser/model-picker';
import { button, field, toggle } from '@mini-harness/ui-primitives/primitives';
import type { ContextSettings } from '../shared/state.ts';

export function settingsForm(ctx: Context, signal: AbortSignal, write: (value: ContextSettings) => Promise<void>) {
  const node = document.createElement('section');
  node.className = 'context-settings';
  const heading = document.createElement('h4');
  heading.textContent = 'Context Management';
  const auto = toggle('Auto compaction', true);
  const model = button('Current model');
  model.classList.add('context-model');
  const modelRow = document.createElement('div');
  modelRow.className = 'ui-field';
  const caption = document.createElement('span');
  caption.textContent = 'Summary model';
  modelRow.append(caption, model);
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
  fields.append(field('Auto compaction', auto), ...ratios.map(({ row }) => row), modelRow, save);
  node.append(heading, fields, error);
  let choice: ModelChoice | null = null;
  const picker = createModelPicker(model, (value) => { choice = value; renderModel(); }, signal, 'Current model', () => { choice = null; renderModel(); });
  function renderModel() {
    const { models, providers } = ctx.miniModels.get();
    picker.update(models, providers, choice);
    model.setAttribute('aria-label', 'Summary model');
  }
  ctx.miniModels.subscribe(renderModel, signal);
  save.onclick = async () => {
    fields.disabled = true;
    error.hidden = true;
    try {
      await write({
        autoCompact: auto.checked,
        triggerRatio: ratios[0].input.valueAsNumber / 100,
        targetRatio: ratios[1].input.valueAsNumber / 100,
        retainRatio: ratios[2].input.valueAsNumber / 100,
        summaryModel: choice,
      });
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
    } finally {
      fields.disabled = false;
    }
  };
  return {
    node,
    update(next: ContextSettings) {
      auto.checked = next.autoCompact;
      for (const { key, input } of ratios) input.value = String(Number((next[key] * 100).toFixed(4)));
      choice = next.summaryModel;
      renderModel();
    },
  };
}
