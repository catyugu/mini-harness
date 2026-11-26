import { hasContent } from './timeline.ts';
import type { Context } from 'mini-harness/cordis';
import { scopedElements, fromMarkup } from '@mini-harness/ui-primitives/primitives';
import { createRunSummary } from './run-summary.ts';
import { renderQueue } from './queue-view.ts';
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
      <div id="runSummary" class="run-summary ui-content-width" aria-label="Latest run" hidden><span></span><time></time><details id="changedFiles" hidden><summary></summary><ul></ul></details></div>
      <div id="conversationHistory" hidden></div>
      <div class="composer-wrap ui-content-width">
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
    const busy = state.interaction.operation === 'open' || state.interaction.operation === 'submit';
    const welcome = !busy && !isRunning(state.run) && !state.history?.timeline.some(hasContent);
    element('welcome').hidden = !welcome;
    element('conversationHistory').hidden = welcome;
    element('status').textContent = state.interaction.status;
    element('status').classList.toggle('error', Boolean(state.interaction.error));
    previous = state;
  }
  function renderTitle() {
    const session = control.get().session;
    const latest = ctx.miniSessions.get().find(({ id }) => id === session?.id);
    ctx.miniHeader.setTitle(latest?.title ?? session?.title ?? 'New conversation');
  }
  control.subscribe(['session'], renderTitle, signal);
  ctx.miniSessions.subscribe(renderTitle, signal);
  control.subscribe(['session', 'history', 'run', 'queue', 'interaction'], render, signal);
  renderTitle();
  render();
}
