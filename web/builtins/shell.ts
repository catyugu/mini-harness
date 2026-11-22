import type { FrontendSetup, ToolView } from '../extensions.js';
import { payload } from '../api.js';

interface Approval { id: string; sessionId: string; command: string }

function renderResult(tool: ToolView) {
  const result = typeof tool.content === 'string' ? tool.content : tool.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!result) return;
  const pre = document.createElement('pre');
  try {
    const output = JSON.parse(result);
    pre.className = 'terminal-output';
    pre.textContent = (typeof output.code === 'number' ? 'Exit ' + output.code + '\n' : '') + (output.stdout ?? '') + (output.stderr ? '\n' + output.stderr : '');
  } catch { pre.textContent = result; }
  return pre;
}

const setup: FrontendSetup = (api, services) => {
  api.tool('sandbox_shell', renderResult);
  api.toolAction('sandbox_shell', () => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'link-button';
    button.textContent = 'Open terminal'; button.onclick = () => services.openResource({ path: '', kind: 'terminal' }); return button;
  });
  api.rightTab('terminal', { title: () => 'Terminal', launcher: 'Shell output', keepMounted: true,
    canOpen: (address) => Boolean(address.sessionId),
    create(address, signal) {
      const node = document.createElement('section');
      node.setAttribute('aria-label', 'Shell output');
      const content = document.createElement('div');
      const refresh = document.createElement('button'); refresh.type = 'button'; refresh.className = 'small-button'; refresh.textContent = 'Refresh output';
      node.append(refresh, content);
      let generation = 0;
      const load = async () => {
        const current = ++generation;
        try {
          const session = await api.request<{ messages: import('../../src/protocol.js').ViewMessage[] }>('/sessions/' + address.sessionId, { signal });
          if (signal.aborted || current !== generation) return;
          const tools = session.messages.filter(({ toolName }) => toolName === 'sandbox_shell');
          content.replaceChildren(...tools.map((tool) => {
            const output = renderResult({ name: 'sandbox_shell', state: tool.isError ? 'error' : 'finished', content: tool.content });
            return output ?? document.createElement('pre');
          }));
          if (!tools.length) content.textContent = 'No recorded shell output in this conversation.';
        } catch (error) { if (!signal.aborted) content.textContent = error.message; }
      };
      refresh.onclick = () => void load();
      services.onRunEvent((event) => { if (event.type === 'tool' && event.name === 'sandbox_shell' && event.state !== 'running' && services.workspace()?.sessionId === address.sessionId) void load(); }, signal);
      services.onConversationChange(() => { if (services.workspace()?.sessionId === address.sessionId) void load(); }, signal);
      void load(); return node;
    }
  });
  const list = document.createElement('div');
  api.mount('approvals', list);
  let pending = false;
  let again = false;
  let previous = '';
  const poll = async () => {
    if (pending) { again = true; return; }
    if (api.signal.aborted || document.hidden) return;
    pending = true;
    try {
      const approvals = (await api.request<Approval[]>('/approvals')).filter(({ sessionId }) => sessionId === services.workspace()?.sessionId);
      if (api.signal.aborted) return;
      const key = JSON.stringify(approvals);
      if (key === previous) return;
      previous = key;
      list.replaceChildren(...approvals.map((approval) => {
        const card = document.createElement('section');
        card.className = 'approval-card';
        const title = document.createElement('strong');
        title.textContent = 'Shell approval · ' + (services.sessionTitle(approval.sessionId) ?? 'Conversation');
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
    } finally { pending = false; if (again) { again = false; void poll(); } }
  };
  services.onRunEvent((event) => { if (event.type === 'approval') void poll(); }, api.signal);
  services.onConversationChange(() => { previous = ''; void poll(); }, api.signal);
  document.addEventListener('visibilitychange', () => void poll(), { signal: api.signal });
  void poll();
};
export default setup;
