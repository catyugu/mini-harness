import type { Context } from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type {} from '@mini-harness/models/browser/api';
import { button, field, toggle } from '@mini-harness/ui-primitives/primitives';
import { ratioIssue, type ContextSettings } from '../shared/state.ts';

export function settingsForm(
  ctx: Context,
  signal: AbortSignal,
  write: (value: ContextSettings) => Promise<void>,
  restore: () => Promise<ContextSettings>,
) {
  const node = document.createElement('section');
  node.className = 'context-settings';
  const heading = document.createElement('h4');
  heading.textContent = 'Compaction';
  const auto = toggle('Auto compaction', true);
  const save = button('Apply', 'primary');
  const reset = button('Restore Default');
  const actions = document.createElement('div');
  actions.className = 'context-actions ui-stack';
  actions.append(save, reset);
  const error = document.createElement('p');
  error.className = 'hint form-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const ratios = (
    [
      ['triggerRatio', 'Trigger threshold (%)'],
      ['targetRatio', 'Target threshold (%)'],
      ['retainRatio', 'Retain ratio (%)'],
    ] as const
  ).map(([key, label]) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0.1';
    input.max = '99.9';
    input.step = '0.1';
    input.setAttribute('aria-label', label);
    return { key, input, row: field(label, input, 'compact') };
  });
  const fields = document.createElement('fieldset');
  fields.className = 'context-fields';
  let choice: ModelChoice | null = null;
  const picker = ctx.miniModels.createPicker(
    (value) => {
      choice = value;
      picker.update(choice);
    },
    signal,
    {
      label: 'Summary model',
      emptyLabel: 'Current model',
      selectEmpty() {
        choice = null;
        picker.update(choice);
      },
    },
  );
  fields.append(
    field('Auto compaction', auto, 'compact'),
    ...ratios.map(({ row }) => row),
    field('Summary model', picker.node, 'compact'),
    actions,
  );
  node.append(heading, fields, error);
  async function submit(operation: () => Promise<void>) {
    fields.disabled = true;
    error.hidden = true;
    try {
      await operation();
    } catch (failure) {
      error.textContent = failure instanceof Error ? failure.message : String(failure);
      error.hidden = false;
    } finally {
      fields.disabled = false;
    }
  }
  save.onclick = () =>
    submit(async () => {
      const value = {
        autoCompact: auto.checked,
        triggerRatio: ratios[0].input.valueAsNumber / 100,
        targetRatio: ratios[1].input.valueAsNumber / 100,
        retainRatio: ratios[2].input.valueAsNumber / 100,
        summaryModel: choice,
      };
      const issue = ratioIssue(value);
      if (issue) throw new Error(issue);
      await write(value);
    });
  reset.onclick = () => submit(async () => update(await restore()));
  function update(next: ContextSettings) {
    auto.checked = next.autoCompact;
    for (const { key, input } of ratios) input.value = String(Number((next[key] * 100).toFixed(4)));
    choice = next.summaryModel;
    picker.update(choice);
  }
  return { node, reset, update };
}
