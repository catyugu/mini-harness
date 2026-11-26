import type { Context } from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import type {} from '@mini-harness/models/browser/api';
import { createModelPicker } from '@mini-harness/models/browser/model-picker';
import type {} from '@mini-harness/settings/browser/api';
import type { ContextSettings } from '../shared/state.ts';

const fields = [
  ['autoCompact', 'Auto compaction'],
  ['triggerRatio', 'Trigger threshold (%)'],
  ['targetRatio', 'Target threshold (%)'],
  ['retainRatio', 'Retain ratio (%)'],
  ['pruneTools', 'Tool result pruning'],
  ['summaryModel', 'Summary model'],
] as const;

export function settingsForm(
  ctx: Context,
  signal: AbortSignal,
  write: (field: keyof ContextSettings, value?: ContextSettings[keyof ContextSettings]) => Promise<void>,
  inherited = false,
) {
  const node = document.createElement('section');
  node.className = 'context-settings';
  const heading = document.createElement('h4');
  heading.textContent = 'Context Management';
  const error = document.createElement('p');
  error.className = 'hint form-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  node.append(heading);
  let current: ContextSettings;
  let overrides: Partial<ContextSettings>;
  let busy = false;
  const sync: (() => void)[] = [];
  const text = (field: keyof ContextSettings) =>
    Object.hasOwn(overrides ?? {}, field) ? 'Override' : 'Inherited';

  async function commit(key: keyof ContextSettings, value?: ContextSettings[keyof ContextSettings]) {
    if (busy) return;
    busy = true;
    error.hidden = true;
    node.setAttribute('aria-busy', 'true');
    for (const control of node.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'))
      control.disabled = true;
    try {
      await write(key, value);
    } catch (failure) {
      if (!signal.aborted) {
        error.textContent = failure instanceof Error ? failure.message : String(failure);
        error.hidden = false;
      }
    } finally {
      busy = false;
      node.removeAttribute('aria-busy');
      if (!signal.aborted) sync.forEach((render) => render());
    }
  }

  for (const [field, name] of fields) {
    const row = document.createElement('div');
    row.className = 'settings-field context-setting';
    const label = document.createElement('label');
    label.append(name);
    row.append(label);
    if (field === 'summaryModel') {
      const model = document.createElement('button');
      model.type = 'button';
      model.className = 'model-select small-button';
      model.textContent = 'Current model';
      label.append(model);
      const picker = createModelPicker(
        model,
        (choice) => void commit(field, choice),
        signal,
        'Current model',
      );
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'link-button';
      reset.textContent = 'Use current model';
      reset.onclick = () => void commit(field, null);
      row.append(reset);
      const render = () => {
        if (!current) return;
        const { models, providers } = ctx.miniModels.get();
        picker.update(
          models,
          providers,
          current.summaryModel ?? ({ provider: '', id: '' } satisfies ModelChoice),
        );
        model.disabled = busy;
        reset.disabled =
          busy || (current.summaryModel === null && (!inherited || Object.hasOwn(overrides, field)));
      };
      ctx.miniModels.subscribe(render, signal);
      sync.push(render);
    } else {
      const input = document.createElement('input');
      const toggle = field === 'autoCompact' || field === 'pruneTools';
      input.type = toggle ? 'checkbox' : 'number';
      if (!toggle) {
        input.min = '0.1';
        input.max = '99.9';
        input.step = '0.1';
      }
      input.setAttribute('aria-label', name);
      input.onchange = () => void commit(field, toggle ? input.checked : input.valueAsNumber / 100);
      label.append(input);
      sync.push(() => {
        if (!current) return;
        if (toggle) input.checked = Boolean(current[field]);
        else if (document.activeElement !== input || busy)
          input.value = String(Number((Number(current[field]) * 100).toFixed(4)));
        input.disabled = busy;
      });
    }
    if (inherited) {
      const inheritance = document.createElement('button');
      inheritance.type = 'button';
      inheritance.className = 'link-button context-inheritance';
      inheritance.onclick = () =>
        void commit(field, Object.hasOwn(overrides, field) ? undefined : current[field]);
      row.append(inheritance);
      sync.push(() => {
        inheritance.textContent = text(field);
        inheritance.disabled = busy;
        inheritance.title = text(field) === 'Inherited' ? 'Override ' + name : 'Inherit ' + name;
        inheritance.setAttribute('aria-label', inheritance.title);
      });
    }
    node.append(row);
  }
  node.append(error);
  return {
    node,
    update(next: ContextSettings, explicit: Partial<ContextSettings> = {}) {
      current = next;
      overrides = explicit;
      sync.forEach((render) => render());
    },
  };
}
