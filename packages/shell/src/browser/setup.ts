import type { Context } from 'mini-harness/cordis';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';

function renderResult(tool: ToolView) {
  const body = document.createElement('div');
  body.className = 'shell-tool-body';
  const args = tool.arguments;
  if (args && typeof args === 'object' && 'command' in args && typeof args.command === 'string') {
    const command = document.createElement('pre');
    command.className = 'shell-command ui-text-output';
    command.setAttribute('aria-label', 'Command');
    command.textContent = args.command;
    body.append(command);
  }
  if (tool.streams) {
    const output = document.createElement('pre');
    output.className = 'ui-text-output';
    output.textContent = (tool.streams.stdout ?? '') + (tool.streams.stderr ?? '');
    body.append(output);
    return body;
  }
  const result =
    typeof tool.content === 'string'
      ? tool.content
      : tool.content
          ?.filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
  if (!result) return body;
  const pre = document.createElement('pre');
  pre.className = 'ui-text-output';
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
  body.append(pre);
  return body;
}

function renderExitCode({ details, state }: ToolView) {
  if (state !== 'finished' && state !== 'error') return;
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
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderExitCode, 'status'));
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'shell',
      ({ arguments: args }) => {
        if (!args || typeof args !== 'object' || !('command' in args) || typeof args.command !== 'string')
          return;
        const node = document.createElement('code');
        node.className = 'shell-tool-summary ui-truncate';
        node.textContent = args.command;
        return node;
      },
      'summary',
    ),
  );
};
export default { inject: ['miniMessages'], provide: [], apply: setup };
