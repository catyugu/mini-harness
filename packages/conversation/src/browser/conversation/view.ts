import type { Context } from 'cordis';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
import { slotExtensions } from '@mini-harness/ui-slots/browser/api';
import { scopedElements, fromMarkup } from '@mini-harness/ui-primitives/primitives';
import { createRunSummary } from './run-summary.js';
import { renderQueue } from './queue-view.js';
import { messageText } from './controller.js';

export function mountConversationLayout(ctx: Context, api: FrontendApi) {
  const control = ctx.miniConversation;
  const view = fromMarkup(`
    <div class="conversation">
      <section id="welcome" class="welcome">
        <img src="/logo.svg" width="52" height="52" alt="">
        <h1>What are we working on?</h1>
        <div id="workspaceWelcome"></div>
      </section>
      <div id="runSummary" class="run-summary" aria-label="Latest run" hidden><span></span><time></time><details id="changedFiles" hidden><summary></summary><ul></ul></details></div>
      <div id="conversationHistory" hidden></div>
      <div class="composer-wrap">
        <div id="approvalRequests" class="approval-requests"></div>
        <div id="queuedMessages" class="queued-messages" hidden></div>
        <div id="status" class="status" role="status"></div>
        <div id="composerOutlet"></div>
      </div>
    </div>`);
  api.contribute(slotExtensions.register, 'conversation.body', view);
  const { element } = scopedElements(view);
  api.contribute(slotExtensions.define, 'conversation.composer-view', element('composerOutlet'), 'single');
  api.contribute(slotExtensions.define, 'conversation.history', element('conversationHistory'), 'single');
  api.contribute(slotExtensions.define, 'conversation.approvals', element('approvalRequests'));
  api.contribute(slotExtensions.define, 'workspace.welcome', element('workspaceWelcome'), 'single');
  const showRun = createRunSummary(element('runSummary'), api.onDispose);
  let previous: ReturnType<typeof control.get> | undefined;
  function render() {
    const state = control.get();
    if (previous?.run !== state.run || !previous) showRun(state.run);
    if (previous?.queue !== state.queue) renderQueue(element('queuedMessages'), state.queue, (id) => void control.cancelQueue(id).catch(control.report));
    const welcome = !state.sending && !state.records.length && !state.events.length &&
      !state.view?.messages.some((message) => message.role === 'toolResult' || messageText(message.content) || message.attachments?.length ||
        message.error || (Array.isArray(message.content) && message.content.some((part) => part.type === 'image'))) &&
      !(state.run?.state === 'failed' && state.run.error);
    element('welcome').hidden = !welcome;
    element('conversationHistory').hidden = welcome;
    ctx.miniHeader.showWorkspace(!welcome);
    ctx.miniHeader.setTitle(state.conversation?.title ?? 'New conversation');
    element('status').textContent = state.status;
    element('status').classList.toggle('error', state.error);
    previous = state;
  }
  control.subscribe(render, api.signal);
  render();
}
