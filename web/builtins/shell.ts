import type { FrontendSetup } from '../extensions.js';
import { payload } from '../api.js';

interface Approval { id: string; sessionId: string; command: string }

const setup: FrontendSetup = (api, services) => {
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
    } finally { pending = false; }
  };
  const timer = setInterval(() => void poll(), 1000);
  api.onDispose(() => clearInterval(timer));
  void poll();
};
export default setup;
