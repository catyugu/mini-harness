import type { Context } from 'mini-harness/cordis';
import { scopedElements, fromMarkup } from '@mini-harness/ui-primitives/primitives';
import { createRunSummary } from './run-summary.js';
import { renderQueue } from './queue-view.js';
import { isRunning } from '@mini-harness/sessions/run-state';

export function mountConversationLayout(ctx: Context) {
  const signal = ctx.fiber.signal;
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
  ctx.effect(() => ctx.miniSlots.register('conversation.body', view));
  const { element } = scopedElements(view);
  ctx.effect(() => ctx.miniSlots.define('conversation.composer-view', element('composerOutlet'), 'single'));
  ctx.effect(() => ctx.miniSlots.define('conversation.history', element('conversationHistory'), 'single'));
  ctx.effect(() => ctx.miniSlots.define('conversation.approvals', element('approvalRequests')));
  ctx.effect(() => ctx.miniSlots.define('workspace.welcome', element('workspaceWelcome'), 'single'));
  const showRun = createRunSummary(element('runSummary'), (dispose) => ctx.effect(() => dispose));
  let previous: ReturnType<typeof control.get> | undefined;
  function render() {
    const state = control.get();
    if (previous?.run !== state.run || !previous) showRun(state.run);
    if (previous?.queue !== state.queue)
      renderQueue(
        element('queuedMessages'),
        state.queue,
        (id) => void control.cancelQueue(id).catch(control.report),
      );
    const welcome =
      !isRunning(state.run) &&
      state.interaction.operation !== 'submit' &&
      !state.history.records.length &&
      !state.history.messages.some(
        (message) =>
          message.role === 'toolResult' ||
          (typeof message.content === 'string'
            ? message.content
            : message.content.some((part) => part.type === 'text' && part.text)) ||
          message.attachments?.length ||
          message.error ||
          (Array.isArray(message.content) && message.content.some((part) => part.type === 'image')),
      ) &&
      !(state.run?.state === 'failed' && state.run.error);
    element('welcome').hidden = !welcome;
    element('conversationHistory').hidden = welcome;
    ctx.miniHeader.showWorkspace(!welcome);
    ctx.miniHeader.setTitle(state.session?.title ?? 'New conversation');
    element('status').textContent = state.interaction.status;
    element('status').classList.toggle('error', Boolean(state.interaction.error));
    previous = state;
  }
  control.subscribe(['session', 'history', 'run', 'queue', 'interaction'], render, signal);
  render();
}
