import type { Context } from 'mini-harness/cordis';
import { browserPluginId, browserPluginSettings } from '@mini-harness/ui-runtime/plugin-settings';
import { button, field } from '@mini-harness/ui-primitives/primitives';
import { shellLimits } from '../limits.ts';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';

function registerConfiguration(ctx: Context) {
  const configuration = browserPluginSettings(ctx);
  ctx.effect(() =>
    ctx.miniSettingsRegistry.registerPlugin(browserPluginId(ctx), () => {
      const form = document.createElement('form');
      form.className = 'shell-config ui-stack';
      const note = document.createElement('p');
      note.className = 'hint';
      note.textContent =
        'Enabling Shell authorizes commands to run with your user permissions without per-command confirmation. Use only trusted workspaces.';
      form.append(note);
      function limit(key: keyof typeof shellLimits) {
        const { title, description, minimum, maximum } = shellLimits[key];
        const input = document.createElement('input');
        input.type = 'number';
        input.required = true;
        input.min = String(minimum);
        input.max = String(maximum);
        input.valueAsNumber = configuration.get<number>(key);
        const caption = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = title;
        const hint = document.createElement('small');
        hint.textContent = description;
        caption.append(name, hint);
        form.append(field(caption, input));
        return input;
      }
      const timeout = limit('timeoutMs');
      const output = limit('maxOutputBytes');
      const save = button('Save configuration', 'primary');
      save.type = 'submit';
      const status = document.createElement('p');
      status.className = 'hint form-error';
      status.setAttribute('role', 'status');
      form.append(save, status);
      form.onsubmit = async (event) => {
        event.preventDefault();
        save.disabled = true;
        status.textContent = '';
        try {
          await configuration.patch({
            timeoutMs: timeout.valueAsNumber,
            maxOutputBytes: output.valueAsNumber,
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

function renderResult(tool: ToolView) {
  if (tool.streams) {
    const pre = document.createElement('pre');
    pre.textContent = (tool.streams.stdout ?? '') + (tool.streams.stderr ?? '');
    return pre;
  }
  const result =
    typeof tool.content === 'string'
      ? tool.content
      : tool.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
  if (!result) return;
  const pre = document.createElement('pre');
  try {
    const output = JSON.parse(result);
    pre.textContent =
      'Exit ' +
      output.code +
      '\n' +
      (output.stdout ?? '') +
      (output.stdoutOverflow ? '\n[Remaining stdout: ' + output.stdoutOverflow + ']' : '') +
      (output.stderr ? '\n' + output.stderr : '') +
      (output.stderrOverflow ? '\n[Remaining stderr: ' + output.stderrOverflow + ']' : '');
  } catch {
    pre.textContent = result;
  }
  return pre;
}

function renderExitCode({ details }: ToolView) {
  const code = details?.exitCode;
  if (typeof code !== 'number') return;
  const node = document.createElement('span');
  node.className = 'tool-exit-code';
  node.textContent = 'Exit ' + code;
  if (code !== 0) node.dataset.failed = 'true';
  return node;
}

const setup = (ctx: Context) => {
  ctx.inject(['miniSettingsRegistry', 'miniPrimitives'], registerConfiguration);
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderResult));
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderExitCode, 'summary'));
};
export default { inject: ['miniMessages'], provide: [], apply: setup };
