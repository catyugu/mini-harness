import type { Context } from 'mini-harness/cordis';
import type { ModelChoice } from '@mini-harness/llm/vocabulary';
import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import { button, field, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
import { childLimits } from '../shared/limits.ts';

export function registerConfiguration(ctx: Context) {
  const configuration = browserPluginSettings(ctx);
  ctx.effect(() =>
    ctx.miniSettingsRegistry.registerPlugin(browserPluginId(ctx), (signal) => {
      const form = fromMarkup<HTMLFormElement>(`<form class="subagent-config ui-stack">
        <section class="ui-section"><h3>Run limits</h3></section>
        <section class="ui-section"><h3>Model selection</h3></section>
        <p class="hint form-error" role="status"></p>
      </form>`);
      const limits = required(form.querySelector('section'));
      const model = required(limits.nextElementSibling);
      const status = required(form.querySelector('[role="status"]'));
      function limit(key: keyof typeof childLimits) {
        const { title, minimum, maximum } = childLimits[key];
        const input = document.createElement('input');
        input.type = 'number';
        input.required = true;
        input.min = String(minimum);
        input.max = String(maximum);
        input.valueAsNumber = configuration.get<number>(key);
        limits.append(field(title, input));
        return input;
      }
      const depth = limit('maxDepth');
      const parallel = limit('maxParallel');
      let choice = configuration.get<ModelChoice | null>('model');
      const choose = (next: ModelChoice | null) => {
        choice = next;
        picker.update(choice);
      };
      const picker = ctx.miniModels.createPicker(choose, signal, {
        label: 'Child model',
        emptyLabel: 'Inherit parent model',
        selectEmpty: () => choose(null),
      });
      picker.update(choice);
      model.append(field('Child model', picker.node));
      const save = button('Save configuration', 'primary');
      save.type = 'submit';
      form.append(save);
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        status.textContent = '';
        try {
          await configuration.patch({
            maxDepth: depth.valueAsNumber,
            maxParallel: parallel.valueAsNumber,
            model: choice,
          });
          status.textContent = 'Saved.';
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          save.disabled = false;
        }
      };
      return form;
    }),
  );
}
