import { conversationExtensions, type ToolView } from '@mini-harness/conversation/browser/composer-api';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';

function renderResult(tool: ToolView) {
  const result = typeof tool.content === 'string' ? tool.content : tool.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!result) return;
  const pre = document.createElement('pre');
  try {
    const output = JSON.parse(result);
    pre.textContent = 'Exit ' + output.code + '\n' + (output.stdout ?? '') + (output.stderr ? '\n' + output.stderr : '');
  } catch { pre.textContent = result; }
  return pre;
}

const setup: FrontendSetup = (ctx, api) => {
  api.contribute(conversationExtensions.tool, 'sandbox_shell', renderResult);
};
export default setup;
