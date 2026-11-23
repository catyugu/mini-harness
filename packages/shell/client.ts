import type { FrontendSetup, ToolView } from '@mini-harness/ui-runtime/frontend';
import { payload } from '@mini-harness/web/api';

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
  const { miniApprovals: approvals, harnessBrowser: services } = ctx;
  api.tool('sandbox_shell', renderResult);
  const list = document.createElement('div');
  api.slots.register('conversation.approvals', list);
  function render() {
    const session = services.session();
    list.replaceChildren(...approvals.get().filter(({ sessionId }) => sessionId === session?.id).map((approval) => {
      const card = document.createElement('section');
      card.className = 'approval-card';
      const title = document.createElement('strong');
      title.textContent = 'Shell approval';
      const command = document.createElement('pre');
      command.textContent = approval.command;
      const origin = document.createElement('small');
      origin.textContent = services.workspaceRecord(session!.workspaceId)?.path ?? session!.title;
      card.append(title, origin, command);
      for (const allow of [false, true]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'small-button';
        button.textContent = allow ? 'Allow once' : 'Deny';
        button.onclick = async () => {
          if (services.session()?.id !== approval.sessionId) return;
          for (const action of card.querySelectorAll('button')) action.disabled = true;
          try {
            await api.request('/approvals', payload('POST', { id: approval.id, allow }));
            await approvals.refresh();
          } catch (error) {
            if (!api.signal.aborted) services.report(error instanceof Error ? error : new Error(String(error)));
            for (const action of card.querySelectorAll('button')) action.disabled = false;
          }
        };
        card.append(button);
      }
      return card;
    }));
  }
  approvals.subscribe(render, api.signal);
  services.onConversationChange(render, api.signal);
  render();
};
export default setup;
