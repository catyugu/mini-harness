import type { Context } from 'mini-harness/cordis';
import type { TaskOutput, TaskSnapshot } from '@mini-harness/tasks/api';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import { icon } from '@mini-harness/ui-primitives/icons';

const live = ({ state }: TaskSnapshot) => ['queued', 'running', 'waiting'].includes(state);
const status = (task: TaskSnapshot) =>
  task.state === 'completed' &&
  task.result &&
  typeof task.result === 'object' &&
  'isError' in task.result &&
  task.result.isError
    ? 'Tool failed'
    : task.cancellationRequested && live(task)
      ? 'Cancelling'
      : task.state;

function setup(ctx: Context) {
  const services = ctx.harnessBrowser;
  const control = ctx.miniConversation;
  const signal = ctx.fiber.signal;
  const events = new EventTarget();
  const container = document.createElement('div');
  container.className = 'background-tasks';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'link-button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', 'backgroundTasks');
  toggle.append(icon('list-checks'), document.createTextNode('Tasks'));
  const panel = document.createElement('div');
  panel.className = 'background-task-list';
  panel.id = 'backgroundTasks';
  panel.popover = 'auto';
  toggle.setAttribute('popovertarget', panel.id);
  container.append(toggle, panel);
  const rows = new Map<string, HTMLDetailsElement>();
  let tasks: TaskSnapshot[] = [];
  let revision = 0;
  let active: string | undefined;
  let outputRequest = new AbortController();
  let reportedError = '';
  const path = (id: string) => '/sessions/' + encodeURIComponent(id) + '/tasks';

  function row(task: TaskSnapshot, id: string) {
    const detail = document.createElement('details');
    const title = document.createElement('summary');
    const bar = document.createElement('div');
    const output = document.createElement('pre');
    const failure = document.createElement('small');
    let cursor = -1;
    let fetching = false;
    const refreshOutput = async () => {
      if (fetching || !detail.open || !panel.contains(detail) || cursor >= Number(detail.dataset.cursor))
        return;
      fetching = true;
      const signal = outputRequest.signal;
      try {
        const data = await browserRequest<TaskOutput>(
          ctx,
          path(id) + '/' + task.id + '/output?after=' + Math.max(0, cursor),
          { signal },
        );
        if (signal.aborted) return;
        if (data.truncated) output.textContent = '[Earlier output was truncated]\n';
        output.append(document.createTextNode(data.chunks.map(({ text }) => text).join('')));
        cursor = data.cursor;
      } catch (error) {
        if (!signal.aborted) failure.textContent = String(error);
      } finally {
        fetching = false;
        if (detail.open && cursor < Number(detail.dataset.cursor) && !signal.aborted && !failure.textContent)
          void refreshOutput();
      }
    };
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy output';
    copy.onclick = () => void navigator.clipboard.writeText(output.textContent ?? '').catch(control.report);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.onclick = () => {
      void browserRequest(ctx, path(id) + '/' + task.id, { method: 'DELETE' }).catch(control.report);
    };
    bar.append(copy, cancel);
    if (task.type === 'agent-run') {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open conversation';
      open.onclick = () => services.openConversation(task.owner.slice('session:'.length));
      bar.append(open);
    }
    detail.append(title, bar, failure, output);
    detail.ontoggle = () => void refreshOutput();
    detail.addEventListener('task-update', (event) => {
      const next = (event as CustomEvent<TaskSnapshot>).detail;
      const label =
        next.type === 'agent-run' ? services.session(next.owner.slice('session:'.length))?.title : next.name;
      const elapsed = next.startedAt
        ? (Date.parse(next.finishedAt ?? new Date().toISOString()) - Date.parse(next.startedAt)) / 1000
        : 0;
      title.textContent =
        (label ?? 'Task') + ' · ' + status(next) + (elapsed >= 1 ? ' · ' + Math.floor(elapsed) + ' s' : '');
      cancel.hidden = !live(next);
      cancel.disabled = next.cancellationRequested;
      detail.dataset.cursor = String(next.outputCursor);
      void refreshOutput();
    });
    return detail;
  }

  function render() {
    const id = active;
    container.hidden = !id;
    if (!id) {
      if (panel.matches(':popover-open')) panel.hidePopover();
      return;
    }
    const displayed = new Set(tasks.map(({ id }) => id));
    for (const [id, node] of rows) {
      if (displayed.has(id)) continue;
      node.remove();
      rows.delete(id);
    }
    if (!tasks.length) panel.textContent = reportedError || 'No background tasks';
    else if (!rows.size) panel.replaceChildren();
    for (const task of tasks) {
      let node = rows.get(task.id);
      if (!node) {
        node = row(task, id);
        rows.set(task.id, node);
        panel.append(node);
      }
      node.dispatchEvent(new CustomEvent('task-update', { detail: task }));
    }
  }

  async function refresh() {
    const id = control.get().session?.id;
    const request = ++revision;
    if (id !== active) {
      active = id;
      outputRequest.abort();
      outputRequest = new AbortController();
      rows.clear();
      tasks = [];
      reportedError = '';
      panel.replaceChildren();
      render();
    }
    if (!id) return;
    try {
      const result = await browserRequest<TaskSnapshot[]>(ctx, path(id), { signal });
      if (signal.aborted || request !== revision) return;
      tasks = result;
      render();
      events.dispatchEvent(new Event('change'));
    } catch (error) {
      if (signal.aborted || request !== revision) return;
      reportedError = String(error);
      render();
    }
  }

  ctx.effect(() => ctx.miniSlots.register('conversation.header', container));
  ctx.effect(() =>
    ctx.miniProjections.register('tasks', {
      sync(_revision, reconnect, id) {
        if (!id || reconnect || id === active) return refresh();
      },
    }),
  );
  control.subscribe(
    ['session'],
    () => {
      if (control.get().session?.id !== active) void refresh();
    },
    signal,
  );
  signal.addEventListener('abort', () => outputRequest.abort(), { once: true });
  const open = () => panel.matches(':popover-open');
  const position = () => {
    const bounds = toggle.getBoundingClientRect();
    panel.style.left =
      Math.max(8, Math.min(bounds.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8)) + 'px';
    panel.style.top = bounds.bottom + 6 + 'px';
  };
  panel.addEventListener(
    'toggle',
    () => {
      toggle.setAttribute('aria-expanded', String(open()));
      if (open()) {
        position();
        void refresh();
      }
    },
    { signal },
  );
  window.addEventListener(
    'resize',
    () => {
      if (open()) position();
    },
    { signal },
  );
  const interval = setInterval(() => {
    if (open()) render();
  }, 1000);
  ctx.effect(() => () => clearInterval(interval));
  const receipt = ({ taskId }: { taskId?: string }, signal: AbortSignal) => {
    if (!taskId) return;
    const label = document.createElement('p');
    const update = () => {
      const task = tasks.find(({ id }) => id === taskId);
      label.textContent = 'Accepted · ' + (task ? status(task) : 'Task ' + taskId);
    };
    events.addEventListener('change', update, { signal });
    update();
    return label;
  };
  for (const name of ['start_background', 'delegate'])
    ctx.effect(() => ctx.miniMessages.registerTool(name, receipt));
  void refresh();
}

export default {
  inject: ['harnessBrowser', 'miniConversation', 'miniSlots', 'miniProjections', 'miniMessages'],
  apply: setup,
};
