import type { Context } from 'mini-harness/cordis';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';

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
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderResult));
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderExitCode, 'summary'));
};
export default { inject: ['miniMessages'], provide: [], apply: setup };
