import type { Context } from 'mini-harness/cordis';
import type { ToolView } from '@mini-harness/conversation/browser/history-api';
import type {} from '@mini-harness/conversation/browser/conversation-api';
import type { TaskData, TaskOutput, TaskSnapshot } from '@mini-harness/tasks/api';
import { browserRequest } from '@mini-harness/ui-runtime/http';
import { icon } from '@mini-harness/ui-primitives/icons';
import {
  bindPopover,
  button,
  fromMarkup,
  required,
  textOutput,
} from '@mini-harness/ui-primitives/primitives';

const live = ({ state }: TaskSnapshot) => ['queued', 'running', 'waiting'].includes(state);
const object = (value?: TaskData): Record<string, TaskData> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function status(task: TaskSnapshot) {
  if (task.cancellationRequested && live(task)) return 'Cancelling';
  if (live(task) && object(task.progress).state === 'approval') return 'Awaiting approval';
  const summary = object(task.result).summary;
  if (task.state === 'completed' && typeof summary === 'string') return summary;
  if (task.state === 'completed' && object(task.result).isError) return 'Failed';
  return task.state[0].toUpperCase() + task.state.slice(1);
}

function duration(task: TaskSnapshot) {
  const seconds = Math.max(
    0,
    Math.floor(
      (Date.parse(task.finishedAt ?? new Date().toISOString()) -
        Date.parse(task.startedAt ?? task.createdAt)) /
        1000,
    ),
  );
  if (seconds >= 3600) return Math.floor(seconds / 3600) + ' h ' + (Math.floor(seconds / 60) % 60) + ' min';
  if (seconds >= 60) return Math.floor(seconds / 60) + ' min ' + (seconds % 60) + ' s';
  return seconds + ' s';
}

function input(task: TaskSnapshot) {
  const args = task.metadata?.arguments;
  return args === undefined ? '' : JSON.stringify(args, null, 2);
}

function resultText(value?: TaskData) {
  const content = object(value).content;
  if (!Array.isArray(content)) return typeof value === 'string' ? value : '';
  return content
    .flatMap((part) => {
      if (typeof part === 'string') return [part];
      const block = object(part);
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    })
    .join('\n');
}

function taskResult(task: TaskSnapshot) {
  return resultText(task.result) || resultText(task.progress);
}

function reconcile(parent: HTMLElement, children: HTMLElement[]) {
  let next = parent.firstElementChild;
  for (const child of children) {
    if (child === next) next = next.nextElementSibling;
    else parent.insertBefore(child, next);
  }
  while (next) {
    const node = next;
    next = next.nextElementSibling;
    node.remove();
  }
}

function setup(ctx: Context) {
  const control = ctx.miniConversation;
  const signal = ctx.fiber.signal;
  const events = new EventTarget();
  const container = fromMarkup(`<div class="background-tasks" hidden>
    <button type="button" class="link-button ui-disclosure-trigger" aria-label="Tasks" aria-expanded="false" aria-controls="backgroundTasks" popovertarget="backgroundTasks"><span class="task-count"></span></button>
    <div id="backgroundTasks" class="background-task-list ui-popover" popover="auto" role="region" aria-label="Tasks">
      <p class="task-notice" role="status"></p>
      <section class="task-group" hidden><h3>Running <span></span></h3><div class="task-rows"></div></section>
      <section class="task-group" hidden><div class="task-group-header">
        <button type="button" class="task-group-toggle" aria-expanded="false"><span></span></button>
        <button type="button" class="task-clear">Clear</button>
      </div><div class="task-rows"></div></section>
    </div>
  </div>`);
  const toggle = required(container.querySelector<HTMLButtonElement>('button'));
  const count = required(toggle.querySelector('span'));
  toggle.append(icon('chevron'));
  const panel = required(container.querySelector<HTMLElement>('#backgroundTasks'));
  const notice = required(panel.querySelector<HTMLElement>('.task-notice'));
  const [running, finished] = [...panel.querySelectorAll<HTMLElement>('.task-group')];
  const runningRows = required(running.querySelector<HTMLElement>('.task-rows'));
  const finishedRows = required(finished.querySelector<HTMLElement>('.task-rows'));
  const finishedToggle = required(finished.querySelector<HTMLButtonElement>('.task-group-toggle'));
  const finishedCount = required(finishedToggle.querySelector('span'));
  finishedToggle.prepend(icon('chevron'));
  const clear = required(finished.querySelector<HTMLButtonElement>('.task-clear'));
  clear.title = 'Hide finished jobs from this panel without deleting their history';
  let tasks: TaskSnapshot[] = [];
  let active: string | undefined;
  let revision = 0;
  let finishedOpen: boolean | undefined;
  const dismissed = new Set<string>();
  const rows = new Map<string, ReturnType<typeof createRow>>();
  const path = (id: string) => '/sessions/' + encodeURIComponent(id) + '/tasks';
  const open = () => panel.matches(':popover-open');
  let expanded: ReturnType<typeof createOutput> | undefined;

  function label(task: TaskSnapshot) {
    return task.name ?? 'Task';
  }

  function closeOutput() {
    expanded?.lifetime.abort();
    expanded?.node.remove();
    expanded = undefined;
  }

  function createOutput(task: TaskSnapshot, sessionId: string) {
    const lifetime = new AbortController();
    const node = fromMarkup(`<div class="task-detail">
      <div class="task-input"><pre></pre></div>
      <div class="task-output-heading"><span>Output</span></div>
      <p class="task-notice" role="status"></p>
      <pre class="task-output" aria-label="Task output"></pre>
      <pre class="task-result-details" aria-label="Task result details" hidden></pre>
    </div>`);
    const command = required(node.querySelector<HTMLElement>('.task-input'));
    const commandText = input(task);
    command.hidden = !commandText;
    required(command.querySelector('pre')).textContent = commandText;
    const copy = (text: () => string, title: string) => {
      const action = button('Copy', 'quiet');
      action.setAttribute('aria-label', title);
      action.title = title;
      action.onclick = () => void navigator.clipboard.writeText(text()).catch(control.report);
      return action;
    };
    command.append(copy(() => commandText, 'Copy arguments'));
    const output = required(node.querySelector<HTMLElement>('.task-output'));
    const warning = required(node.querySelector<HTMLElement>('.task-notice'));
    const resultDetails = required(node.querySelector<HTMLElement>('.task-result-details'));
    required(node.querySelector('.task-output-heading')).append(
      copy(() => output.textContent ?? '', 'Copy output'),
    );
    let cursor = 0;
    let fetching = false;
    let text = '';
    let truncated = false;
    let failure = '';
    function show(next: TaskSnapshot) {
      const following = output.scrollHeight - output.scrollTop - output.clientHeight < 16;
      const fallback = taskResult(next);
      const shown = text || fallback || (live(next) ? 'Waiting for output…' : 'No output');
      if (output.textContent !== shown) {
        output.textContent = shown;
        if (following) output.scrollTop = output.scrollHeight;
      }
      const details = object(object(next.result).details);
      const metadata = Object.keys(details).length ? JSON.stringify(details, null, 2) : '';
      if (resultDetails.textContent !== metadata) resultDetails.textContent = metadata;
      resultDetails.hidden = !metadata;
      warning.textContent = [truncated ? 'Earlier output was truncated' : '', failure || next.error || '']
        .filter(Boolean)
        .join(' · ');
    }
    async function update(next: TaskSnapshot) {
      show(next);
      if (fetching || lifetime.signal.aborted || next.outputCursor <= cursor) return;
      fetching = true;
      const requestedCursor = cursor;
      try {
        const data = await browserRequest<TaskOutput>(
          ctx,
          path(sessionId) + '/' + encodeURIComponent(task.id) + '/output?after=' + cursor,
          { signal: lifetime.signal },
        );
        if (lifetime.signal.aborted) return;
        if (data.truncated) {
          truncated = true;
          text = '';
        }
        text += data.chunks.map(({ text }) => text).join('');
        if (text.length > 1024 * 1024) {
          truncated = true;
          text = text.slice(-1024 * 1024);
        }
        cursor = data.cursor;
        failure = '';
      } catch (error) {
        if (!lifetime.signal.aborted) failure = String(error);
      } finally {
        fetching = false;
        const latest = tasks.find(({ id }) => id === task.id);
        if (!lifetime.signal.aborted && latest) {
          show(latest);
          if (!failure && cursor > requestedCursor && cursor < latest.outputCursor) void update(latest);
        }
      }
    }
    return { id: task.id, node, lifetime, update };
  }

  function showOutput(task: TaskSnapshot) {
    if (!active) return;
    const wasOpen = expanded?.id === task.id;
    closeOutput();
    if (!wasOpen) expanded = createOutput(task, active);
    render();
  }

  function createRow(task: TaskSnapshot) {
    const node = fromMarkup(`<div class="task-item">
      <div class="task-line ui-list-row">
        <button type="button" class="task-row ui-row ui-fill">
          <span class="task-dot ui-status-dot" aria-hidden="true"></span><span class="task-kind ui-meta"></span>
          <span class="task-label ui-fill ui-truncate"></span><span class="task-state ui-meta"></span><time></time>
        </button>
      </div>
    </div>`);
    node.dataset.taskId = task.id;
    const line = required(node.querySelector('.task-line'));
    const row = required(node.querySelector<HTMLButtonElement>('.task-row'));
    const dot = required(row.querySelector<HTMLElement>('.task-dot'));
    const kind = required(row.querySelector<HTMLElement>('.task-kind'));
    const name = required(row.querySelector<HTMLElement>('.task-label'));
    const state = required(row.querySelector<HTMLElement>('.task-state'));
    const time = required(row.querySelector('time'));
    const chevron = icon('chevron');
    row.append(chevron);
    const cancel = button('', 'quiet');
    cancel.classList.add('task-cancel');
    cancel.append(icon('stop'));
    line.append(cancel);
    let current = task;
    row.onclick = () => showOutput(current);
    cancel.onclick = async () => {
      if (!active || !live(current) || current.cancellationRequested) return;
      cancel.disabled = true;
      try {
        await browserRequest(ctx, path(active) + '/' + encodeURIComponent(task.id), { method: 'DELETE' });
      } catch (error) {
        control.report(error instanceof Error ? error : new Error(String(error)));
      } finally {
        cancel.disabled = current.cancellationRequested || !live(current);
      }
    };
    function tick() {
      time.textContent = duration(current);
    }
    function update(next: TaskSnapshot) {
      current = next;
      const title = label(next);
      name.textContent = title;
      const tool = next.metadata?.tool;
      kind.textContent = typeof tool === 'string' && tool !== title ? tool : '';
      kind.hidden = !kind.textContent;
      state.textContent = status(next);
      node.dataset.state = next.state;
      node.dataset.tone =
        next.state === 'completed' && object(next.result).isError
          ? 'failed'
          : next.cancellationRequested && live(next)
            ? 'cancelled'
            : next.state;
      const tone = node.dataset.tone;
      dot.dataset.tone =
        tone === 'running' || tone === 'queued'
          ? 'info'
          : tone === 'completed'
            ? 'success'
            : tone === 'failed' || tone === 'interrupted'
              ? 'danger'
              : tone === 'waiting' || tone === 'cancelled'
                ? 'warning'
                : 'neutral';
      row.title = title + ' · ' + state.textContent;
      row.setAttribute('aria-label', title + ' · ' + state.textContent);
      row.setAttribute('aria-expanded', String(expanded?.id === next.id));
      chevron.classList.toggle('task-chevron-open', expanded?.id === next.id);
      cancel.hidden = !live(next);
      cancel.disabled = next.cancellationRequested;
      cancel.title = 'Cancel task';
      cancel.setAttribute('aria-label', 'Cancel ' + title);
      tick();
      if (expanded?.id === next.id) {
        if (expanded.node.parentElement !== node) node.append(expanded.node);
        void expanded.update(next);
      }
    }
    return { node, update, tick };
  }

  function render() {
    const pending = tasks.filter(live);
    const settled = tasks.filter((task) => !live(task) && !dismissed.has(task.id));
    const finishedExpanded = finishedOpen ?? pending.length === 0;
    const visible = [...pending, ...(finishedExpanded ? settled : [])];
    const displayed = new Set(visible.map(({ id }) => id));
    if (expanded && !displayed.has(expanded.id)) closeOutput();
    for (const [id, row] of rows) {
      if (displayed.has(id)) continue;
      row.node.remove();
      rows.delete(id);
    }
    const mount = (parent: HTMLElement, list: TaskSnapshot[]) => {
      const nodes = list.map((task) => {
        let row = rows.get(task.id);
        if (!row) {
          row = createRow(task);
          rows.set(task.id, row);
        }
        row.update(task);
        return row.node;
      });
      reconcile(parent, nodes);
    };
    mount(runningRows, pending);
    mount(finishedRows, finishedExpanded ? settled : []);
    running.hidden = !pending.length;
    finished.hidden = !settled.length;
    finishedRows.hidden = !finishedExpanded;
    required(running.querySelector('h3 span')).textContent = String(pending.length);
    finishedCount.textContent = 'Finished ' + settled.length;
    finishedToggle.setAttribute('aria-expanded', String(finishedExpanded));
    const total = pending.length + settled.length;
    const liveCount = pending.length;
    count.textContent = total + (total === 1 ? ' task' : ' tasks');
    toggle.dataset.tone = liveCount > 0 ? 'info' : 'neutral';
    toggle.title = liveCount + ' running · ' + (total - liveCount) + ' finished';
    container.hidden = !active || (!total && !notice.textContent);
    if (container.hidden && open()) panel.hidePopover();
  }
  finishedToggle.onclick = () => {
    finishedOpen = finishedToggle.getAttribute('aria-expanded') !== 'true';
    render();
  };
  clear.onclick = () => {
    for (const task of tasks) if (!live(task)) dismissed.add(task.id);
    finishedOpen = undefined;
    render();
  };

  async function refresh() {
    const id = control.get().session?.id;
    const request = ++revision;
    if (id !== active) {
      if (open()) panel.hidePopover();
      closeOutput();
      active = id;
      tasks = [];
      dismissed.clear();
      finishedOpen = undefined;
      notice.textContent = '';
      render();
    }
    if (!id) return;
    try {
      const result = await browserRequest<TaskSnapshot[]>(ctx, path(id), { signal });
      if (signal.aborted || request !== revision) return;
      tasks = result;
      notice.textContent = '';
      render();
      events.dispatchEvent(new Event('change'));
    } catch (error) {
      if (signal.aborted || request !== revision) return;
      tasks = [];
      notice.textContent = String(error);
      render();
      events.dispatchEvent(new Event('change'));
    }
  }

  ctx.effect(() => ctx.miniSlots.register('header.actions', container));
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
  signal.addEventListener('abort', closeOutput, { once: true });
  bindPopover(toggle, panel, signal);
  panel.addEventListener(
    'toggle',
    () => {
      if (open()) void refresh();
      else {
        closeOutput();
        render();
      }
    },
    { signal },
  );
  const interval = setInterval(() => {
    if (open()) for (const row of rows.values()) row.tick();
  }, 1000);
  ctx.effect(() => () => clearInterval(interval));
  function toolInput(args: unknown) {
    return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
  }
  function contentText(content: ToolView['content']) {
    return typeof content === 'string'
      ? content
      : (content
          ?.filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n') ?? '');
  }
  const receipt = (signal: AbortSignal) => {
    const node = document.createElement('div');
    node.className = 'background-tool-body';
    const title = document.createElement('strong');
    const input = textOutput('');
    const line = document.createElement('div');
    line.className = 'task-receipt';
    const text = document.createElement('span');
    const view = button('View task', 'quiet');
    line.append(text, view);
    const output = textOutput('');
    node.append(title, input, line, output);
    let taskId: string | undefined;
    let receiptOutput = '';
    let previousArgs: unknown = Symbol();
    view.onclick = () => {
      const task = tasks.find(({ id }) => id === taskId);
      if (!task) return;
      dismissed.delete(task.id);
      if (!live(task)) finishedOpen = true;
      render();
      if (!open()) panel.showPopover();
      if (expanded?.id !== task.id) showOutput(task);
    };
    function refreshReceipt() {
      const task = tasks.find(({ id }) => id === taskId);
      const caption = task ? label(task) + ' · ' + status(task) : 'Accepted · Task details unavailable';
      if (text.textContent !== caption) text.textContent = caption;
      line.hidden = !taskId;
      view.hidden = !task;
      const result = (task && (taskResult(task) || task.error)) || receiptOutput;
      if (output.textContent !== result) output.textContent = result;
      output.hidden = !result;
    }
    events.addEventListener('change', refreshReceipt, { signal });
    return {
      node,
      update({ details, content, arguments: args }: ToolView) {
        if (args !== previousArgs) {
          previousArgs = args;
          const value = toolInput(args);
          const label = typeof value.tool === 'string' ? value.tool : '';
          const shown =
            label && value.arguments !== undefined ? JSON.stringify(value.arguments, null, 2) : '';
          if (title.textContent !== label) title.textContent = label;
          if (input.textContent !== shown) input.textContent = shown;
          title.hidden = !label;
          input.hidden = !shown;
        }
        taskId = typeof details?.taskId === 'string' ? details.taskId : undefined;
        receiptOutput = contentText(content);
        refreshReceipt();
      },
    };
  };
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'start_background',
      () => {
        const node = document.createElement('span');
        node.className = 'background-tool-summary ui-truncate';
        const label = document.createElement('code');
        const id = document.createTextNode('');
        node.append(label, id);
        return {
          node,
          update({ arguments: args, details }) {
            const input = toolInput(args);
            const tool = typeof input.tool === 'string' ? input.tool : '';
            const target = typeof details?.taskId === 'string' ? ' · ' + details.taskId : '';
            if (label.textContent !== tool) label.textContent = tool;
            if (id.data !== target) id.data = target;
            node.hidden = !tool;
          },
        };
      },
      'summary',
    ),
  );
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'task_control',
      () => {
        const node = document.createElement('span');
        node.className = 'background-tool-summary ui-truncate';
        const action = document.createElement('strong');
        const id = document.createTextNode('');
        node.append(action, id);
        return {
          node,
          update({ arguments: args }) {
            const input = toolInput(args);
            const name = typeof input.action === 'string' ? input.action : '';
            const target = typeof input.taskId === 'string' ? ' · ' + input.taskId : '';
            if (action.textContent !== name) action.textContent = name;
            if (id.data !== target) id.data = target;
            node.hidden = !name;
          },
        };
      },
      'summary',
    ),
  );
  ctx.effect(() => ctx.miniMessages.registerTool('start_background', receipt));
  ctx.effect(() =>
    ctx.miniMessages.registerTool('task_control', () => {
      const node = document.createElement('div');
      node.className = 'background-tool-body';
      const output = textOutput('');
      node.append(output);
      return {
        node,
        update({ content }) {
          const text = contentText(content);
          if (output.textContent !== text) output.textContent = text;
          output.hidden = !text;
        },
      };
    }),
  );
  ctx.effect(() =>
    ctx.miniMessages.registerTool(
      'start_background',
      () => {
        const node = document.createElement('span');
        return {
          node,
          update({ details }) {
            const text = details?.state === 'accepted' ? 'Accepted' : '';
            if (node.textContent !== text) node.textContent = text;
          },
        };
      },
      'status',
    ),
  );
  void refresh();
}

export default {
  inject: ['miniConversation', 'miniSlots', 'miniProjections', 'miniMessages'],
  apply: setup,
};
