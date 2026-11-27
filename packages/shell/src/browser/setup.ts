import type { Context } from 'mini-harness/cordis';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';
import { textOutput } from '@mini-harness/ui-primitives/primitives';

function commandOf(args: unknown) {
  return args && typeof args === 'object' && 'command' in args && typeof args.command === 'string'
    ? args.command
    : '';
}

function renderResult() {
  const node = document.createElement('div');
  node.className = 'shell-tool-body';
  const command = textOutput('');
  command.classList.add('shell-command');
  command.setAttribute('aria-label', 'Command');
  const output = textOutput('');
  const outputText = document.createTextNode('');
  output.append(outputText);
  node.append(command, output);
  let previousContent: ToolView['content'];
  let previousStreams: ToolView['streams'];
  function textOf(tool: ToolView) {
    if (tool.streams) return (tool.streams.stdout ?? '') + (tool.streams.stderr ?? '');
    const result =
      typeof tool.content === 'string'
        ? tool.content
        : tool.content
            ?.filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
    if (!result) return '';
    try {
      const value = JSON.parse(result);
      return (
        'Exit ' +
        value.code +
        '\n' +
        (value.stdout ?? '') +
        (value.stdoutOverflow ? '\n[Remaining stdout: ' + value.stdoutOverflow + ']' : '') +
        (value.stderr ? '\n' + value.stderr : '') +
        (value.stderrOverflow ? '\n[Remaining stderr: ' + value.stderrOverflow + ']' : '')
      );
    } catch {
      return result;
    }
  }
  return {
    node,
    update(tool: ToolView) {
      const input = commandOf(tool.arguments);
      if (command.textContent !== input) command.textContent = input;
      command.hidden = !input;
      if (previousContent !== tool.content || previousStreams !== tool.streams) {
        previousContent = tool.content;
        previousStreams = tool.streams;
        const result = textOf(tool);
        const following = output.scrollHeight - output.scrollTop - output.clientHeight < 16;
        if (outputText.data !== result) {
          if (result.startsWith(outputText.data)) outputText.appendData(result.slice(outputText.length));
          else outputText.data = result;
          if (following) output.scrollTop = output.scrollHeight;
        }
      }
      output.hidden = !output.textContent;
    },
  };
}

function renderExitCode() {
  const node = document.createElement('span');
  node.className = 'tool-exit-code';
  return {
    node,
    update({ details, state }: ToolView) {
      const code = details?.exitCode;
      const show = (state === 'finished' || state === 'error') && typeof code === 'number';
      const label = show ? 'Exit ' + code : '';
      if (node.textContent !== label) node.textContent = label;
      if (show && code !== 0) node.dataset.failed = 'true';
      else delete node.dataset.failed;
    },
  };
}

const setup = (ctx: Context) => {
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderResult));
  ctx.effect(() => ctx.miniMessages.registerTool('shell', renderExitCode, 'status'));
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'shell',
      () => {
        const node = document.createElement('code');
        node.className = 'shell-tool-summary ui-truncate';
        return {
          node,
          update(tool) {
            const command = commandOf(tool.arguments);
            if (node.textContent !== command) node.textContent = command;
            node.hidden = !command;
          },
        };
      },
      'summary',
    ),
  );
};
export default { inject: ['miniMessages'], provide: [], apply: setup };
