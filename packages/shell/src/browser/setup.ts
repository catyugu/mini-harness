import type { Context } from 'mini-harness/cordis';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';

function renderResult(tool: ToolView) {
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

const setup = (ctx: Context) => {
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderResult));
};
export default { inject: ['miniMessages'], provide: [], apply: setup };
