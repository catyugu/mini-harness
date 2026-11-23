import type { FrontendSetup, ToolView } from '../web/kernel/extensions.js';
import { payload } from '../web/api.js';

interface Approval { id: string; sessionId: string; command: string }

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

const setup: FrontendSetup = (api, services) => {
  api.tool('sandbox_shell', renderResult);
  const list = document.createElement('div');
  api.mount('approvals', list);
  let pending = false;
  let previous = '';
  const poll = async () => {
    if (pending || api.signal.aborted || document.hidden) return;
    pending = true;
    try {
      const approvals = await api.request<Approval[]>('/approvals');
      if (api.signal.aborted) return;
      const key = JSON.stringify(approvals);
      if (key === previous) return;
      previous = key;
      list.replaceChildren(...approvals.map((approval) => {
        const card = document.createElement('section');
        card.className = 'approval-card';
        const title = document.createElement('strong');
        title.textContent = 'Shell approval · ' + (services.session(approval.sessionId)?.title ?? 'Conversation');
        const command = document.createElement('pre');
        command.textContent = approval.command;
        card.append(title, command);
        for (const allow of [false, true]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'small-button';
          button.textContent = allow ? 'Allow once' : 'Deny';
          button.onclick = async () => {
            for (const action of card.querySelectorAll('button')) action.disabled = true;
            try {
              await api.request('/approvals', payload('POST', { id: approval.id, allow }));
              card.remove();
              previous = '';
              void poll();
            } catch (error) {
              if (!api.signal.aborted) services.report(error);
              for (const action of card.querySelectorAll('button')) action.disabled = false;
            }
          };
          card.append(button);
        }
        return card;
      }));
    } catch (error) {
      if (!api.signal.aborted) services.report(error);
    } finally { pending = false; }
  };
  const timer = setInterval(() => void poll(), 1000);
  api.onDispose(() => clearInterval(timer));
  void poll();
};
export default setup;
