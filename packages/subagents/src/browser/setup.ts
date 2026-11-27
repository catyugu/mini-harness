import { registerConfiguration } from './configuration.ts';
import type { Context } from 'mini-harness/cordis';
import { isRunning, type RunInfo } from '@mini-harness/sessions/run-state';
import { icon } from '@mini-harness/ui-primitives/icons';
import { bindPopover, fromMarkup, required } from '@mini-harness/ui-primitives/primitives';

function runStatus(run?: RunInfo, waitingApproval = false) {
  if (waitingApproval && isRunning(run)) return 'Awaiting approval';
  return run ? run.state[0].toUpperCase() + run.state.slice(1) : 'Idle';
}

function duration(run: RunInfo) {
  const seconds = Math.max(
    0,
    Math.floor((Date.parse(run.finishedAt ?? new Date().toISOString()) - Date.parse(run.startedAt)) / 1000),
  );
  return seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' s';
}

const setup = (ctx: Context) => {
  ctx.inject(['miniSettingsRegistry', 'miniModels'], registerConfiguration);
  const signal = ctx.fiber.signal;
  const services = ctx.harnessBrowser;
  const trail = document.createElement('nav');
  trail.className = 'parent-conversations';
  trail.setAttribute('aria-label', 'Parent conversations');
  const container = fromMarkup(`<div class="subagent-tasks" hidden>
    <button type="button" class="link-button ui-disclosure-trigger" aria-label="Subagents" aria-expanded="false" aria-controls="subagentTasks" popovertarget="subagentTasks"><span></span></button>
    <div id="subagentTasks" class="ui-popover subagent-list" popover="auto" role="region" aria-label="Subagents"></div>
  </div>`);
  const toggle = required(container.querySelector<HTMLButtonElement>('button'));
  const count = required(toggle.querySelector('span'));
  toggle.append(icon('chevron'));
  const panel = required(container.querySelector<HTMLElement>('#subagentTasks'));
  bindPopover(toggle, panel, signal);
  let active: string | undefined;
  let clocks: { time: HTMLTimeElement; run: RunInfo }[] = [];

  const tick = () => {
    for (const { time, run } of clocks) time.textContent = duration(run);
  };
  function render() {
    const session = services.session();
    const parentId = session?.id;
    if (active !== parentId && panel.matches(':popover-open')) panel.hidePopover();
    active = parentId;
    const parents = [];
    for (let id = session?.parentId; id; ) {
      const parent = services.session(id);
      if (!parent) break;
      parents.unshift(parent);
      id = parent.parentId;
    }
    trail.hidden = !parents.length;
    trail.replaceChildren(
      ...parents.map(({ id, title }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button';
        button.title = title;
        button.textContent = title;
        button.onclick = () => services.openConversation(id);
        const step = document.createElement('span');
        step.append(button, icon('chevron'));
        return step;
      }),
    );

    const children = parentId ? ctx.miniSessions.get().filter((child) => child.parentId === parentId) : [];
    const running = children.filter(({ run }) => isRunning(run)).length;
    count.textContent = children.length + (children.length === 1 ? ' subagent' : ' subagents');
    toggle.dataset.tone = running > 0 ? 'info' : 'neutral';
    toggle.title = running + ' running · ' + (children.length - running) + ' idle or finished';
    container.hidden = !children.length;
    if (container.hidden && panel.matches(':popover-open')) panel.hidePopover();
    clocks = [];
    const focused = (document.activeElement as HTMLElement | null)?.dataset.childSession;
    panel.replaceChildren(
      ...children.map(({ id, title, run, waitingApproval }) => {
        const row = fromMarkup<HTMLButtonElement>(`<button type="button" class="subagent-row">
          <span class="subagent-dot ui-status-dot" aria-hidden="true"></span><span class="subagent-title ui-truncate"></span>
          <span class="subagent-status ui-meta"></span><time></time>
        </button>`);
        row.dataset.childSession = id;
        row.dataset.state = run?.state ?? 'idle';
        const dot = required(row.querySelector<HTMLElement>('.subagent-dot'));
        dot.dataset.tone =
          run?.state === 'running' || run?.state === 'queued'
            ? 'info'
            : run?.state === 'completed'
              ? 'success'
              : run?.state === 'failed' || run?.state === 'interrupted'
                ? 'danger'
                : waitingApproval || run?.state === 'cancelled'
                  ? 'warning'
                  : 'neutral';
        row.setAttribute('aria-label', 'Open conversation: ' + title);
        row.title = title;
        required(row.querySelector('.subagent-title')).textContent = title;
        required(row.querySelector('.subagent-status')).textContent = runStatus(run, waitingApproval);
        if (run) {
          const time = required(row.querySelector('time'));
          time.textContent = duration(run);
          clocks.push({ time, run });
        }
        row.append(icon('chevron'));
        row.onclick = () => {
          panel.hidePopover();
          services.openConversation(id);
        };
        return row;
      }),
    );
    if (focused) panel.querySelector<HTMLElement>('[data-child-session="' + focused + '"]')?.focus();
  }

  ctx.effect(() => ctx.miniSlots.register('header.context', trail));
  ctx.effect(() => ctx.miniSlots.register('header.actions', container));
  services.onConversationChange(render, signal);
  render();
  const timer = setInterval(() => {
    if (panel.matches(':popover-open')) tick();
  }, 1000);
  ctx.effect(() => () => clearInterval(timer));
  ctx.effect(() =>
    ctx.miniMessages.registerTool('delegate', ({ details }, lifetime) => {
      const sessionId = details?.sessionId;
      if (typeof sessionId !== 'string') return;
      const text = document.createElement('span');
      text.className = 'subagent-receipt';
      const update = () => {
        const child = services.session(sessionId);
        text.textContent = child
          ? child.title + ' · ' + runStatus(child.run, child.waitingApproval)
          : 'Accepted';
      };
      services.onConversationChange(update, lifetime);
      update();
      return text;
    }),
  );
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'delegate',
      ({ details }) => {
        const sessionId = details?.sessionId;
        if (typeof sessionId !== 'string') return;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'link-button';
        button.append(icon('chevron'), document.createTextNode(' Open child conversation'));
        button.onclick = () => services.openConversation(sessionId);
        return button;
      },
      'action',
    ),
  );
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'delegate',
      ({ details }) => {
        if (details?.state !== 'accepted' && details?.state !== 'queued') return;
        const node = document.createElement('span');
        node.textContent = details.state === 'queued' ? 'Queued' : 'Accepted';
        return node;
      },
      'status',
    ),
  );
};
export default {
  inject: ['harnessBrowser', 'miniSessions', 'miniMessages', 'miniSlots'],
  provide: [],
  apply: setup,
};
