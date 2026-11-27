import type { Context } from 'mini-harness/cordis';
import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import { button, field } from '@mini-harness/ui-primitives/primitives';
import { turnLimit } from '../limits.ts';

function registerConfiguration(ctx: Context) {
  const configuration = browserPluginSettings(ctx);
  ctx.effect(() =>
    ctx.miniSettingsRegistry.registerPlugin(browserPluginId(ctx), () => {
      const form = document.createElement('form');
      form.className = 'agent-config ui-stack';
      const input = document.createElement('input');
      input.type = 'number';
      input.required = true;
      input.min = String(turnLimit.minimum);
      input.max = String(turnLimit.maximum);
      input.valueAsNumber = configuration.get<number>('maxTurns');
      const save = button('Save configuration', 'primary');
      save.type = 'submit';
      const status = document.createElement('p');
      status.className = 'hint form-error';
      status.setAttribute('role', 'status');
      form.append(field('Maximum turns per run', input), save, status);
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        status.textContent = '';
        try {
          await configuration.set('maxTurns', input.valueAsNumber);
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

function setup(ctx: Context) {
  ctx.inject(['miniSettingsRegistry'], registerConfiguration);
  ctx.effect(() =>
    ctx.miniMessages.registerRecord('core:agent', 'reasoning', (record, { subscribe }) => {
      const body = document.createElement('p');
      const row = ctx.miniPrimitives.recordRow(record.title, body);
      row.classList.add('assistant-reasoning');
      const render = (entry: typeof record) => {
        body.textContent = Array.isArray(entry.content)
          ? entry.content
              .flatMap((part) => (part.type === 'thinking' && !part.redacted ? [part.thinking] : []))
              .join('\n')
          : (entry.streams?.text ?? '');
      };
      render(record);
      subscribe(render);
      return row;
    }),
  );
}

export default { inject: ['miniMessages', 'miniPrimitives'], apply: setup };
