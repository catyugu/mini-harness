import type { Context } from 'mini-harness/cordis';
import type { LiveRecord } from '@mini-harness/runs/stream';
import type { HistoryEntry, MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { RunInfo, RunTermination } from '@mini-harness/sessions/run-state';
import type {
  MessageAction,
  MessageActionContext,
  MessageActionTarget,
  TurnFooterRenderer,
} from '../history-api.ts';
import { icon } from '@mini-harness/ui-primitives/icons';
import { renderMarkdown } from '@mini-harness/ui-primitives/markdown';
import { imageMime } from './attachment-card.ts';
import { attachmentView } from './attachment-view.ts';
import { renderReferences } from './file-references.ts';
import type { MessageExtensions } from './message-extensions.ts';
import { groupHistory, textOf } from './timeline.ts';
import { notificationLabel } from './notification.ts';

export function createMessageView(
  ctx: Context,
  signal: AbortSignal,
  viewport: HTMLElement,
  messages: HTMLElement,
  extensions: MessageExtensions,
  current: () => { workspaceId?: string; sessionId?: string; leafId?: string | null },
  retryLast: () => void,
) {
  const toolItems = new WeakMap<HTMLDetailsElement, Parameters<typeof toolCard>[0]>();
  const resources = new Map<HTMLElement, AbortController>();
  signal.addEventListener(
    'abort',
    () => {
      for (const resource of resources.values()) resource.abort();
      resources.clear();
    },
    { once: true },
  );
  const footers = new WeakMap<HTMLElement, Map<TurnFooterRenderer, HTMLElement>>();
  const actionContext = new WeakMap<HTMLElement, Omit<MessageActionContext, 'signal'>>();
  const actionOwners = new WeakMap<HTMLButtonElement, MessageAction>();
  const nodes = new Map<string, { node: HTMLElement; source: unknown }>();
  const recordUpdates = new WeakMap<HTMLElement, (record: LiveRecord) => void>();
  const preview = document.createElement('div');
  preview.className = 'message assistant';
  let following = true;
  let followedOffset: number | undefined;

  const scrollToEnd = () => {
    if (following && viewport.clientHeight) {
      viewport.scrollTop = viewport.scrollHeight;
      followedOffset = viewport.scrollTop;
    }
  };
  viewport.addEventListener(
    'scroll',
    () => {
      // The scroll event for our own scroll can arrive after the content grows.
      if (following && viewport.scrollTop === followedOffset) return;
      if (viewport.clientHeight)
        following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 8;
    },
    { signal },
  );
  const resize = new ResizeObserver(scrollToEnd);
  resize.observe(viewport);
  resize.observe(messages);
  signal.addEventListener('abort', () => resize.disconnect(), { once: true });
  function updateTimestamp(time: HTMLTimeElement, timestamp: number) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime()) || time.dateTime === date.toISOString()) return;
    time.dateTime = date.toISOString();
    time.textContent = date.toLocaleString(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function messageActions(wrapper: HTMLElement, target: MessageActionTarget, timestamp: number) {
    const { sessionId, leafId } = current();
    if (sessionId) actionContext.set(wrapper, { sessionId, leafId, target });
    let group = wrapper.querySelector<HTMLElement>(':scope > .message-actions');
    if (!group) {
      group = document.createElement('div');
      group.className = 'message-actions';
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', 'Message actions');
    }
    let time = group.querySelector('time');
    if (!time) {
      time = document.createElement('time');
      time.className = 'message-time';
      group.append(time);
    }
    updateTimestamp(time, timestamp);
    return group;
  }

  function renderMessageActions(wrapper: HTMLElement) {
    const group = wrapper.querySelector<HTMLElement>(':scope > .message-actions');
    const context = actionContext.get(wrapper);
    if (!group || !context) return;
    const available = new Map(
      [...group.querySelectorAll<HTMLButtonElement>('[data-message-action]')].map((button) => [
        button.dataset.messageAction,
        button,
      ]),
    );
    const at = { ...context, leafId: current().leafId };
    for (const extension of extensions.actionsForMessage()) {
      const existing = available.get(extension.id);
      if (existing && actionOwners.get(existing) !== extension) remove(existing);
      const button =
        existing && actionOwners.get(existing) === extension ? existing : document.createElement('button');
      const lifetime = resources.get(button) ?? new AbortController();
      try {
        if (!extension.visible({ ...at, signal: lifetime.signal })) {
          lifetime.abort();
          continue;
        }
      } catch (error) {
        lifetime.abort();
        extensions.report(error);
        continue;
      }
      resources.set(button, lifetime);
      actionOwners.set(button, extension);
      available.delete(extension.id);
      button.type = 'button';
      button.className = 'message-action';
      button.dataset.messageAction = extension.id;
      if (button.title !== extension.successLabel && !button.disabled) {
        button.title = extension.label;
        button.setAttribute('aria-label', extension.label);
      }
      if (!button.parentElement) button.append(icon(extension.icon));
      button.onclick = () => {
        button.disabled = true;
        const signal = lifetime.signal;
        void Promise.resolve()
          .then(() => {
            signal.throwIfAborted();
            return extension.run({
              ...(actionContext.get(wrapper) ?? context),
              leafId: current().leafId,
              signal,
            });
          })
          .then(() => {
            if (!signal.aborted && extension.successLabel) {
              button.title = extension.successLabel;
              button.setAttribute('aria-label', extension.successLabel);
            }
          })
          .catch((error) => {
            if (signal.aborted) return;
            button.title = error instanceof Error ? error.message : String(error);
            button.setAttribute('aria-label', 'Action failed: ' + button.title);
          })
          .finally(() => {
            button.disabled = false;
          });
      };
      if (!button.parentElement) group.append(button);
    }
    for (const button of available.values()) remove(button);
  }

  function refreshActions() {
    for (const wrapper of messages.querySelectorAll<HTMLElement>('.message-row'))
      renderMessageActions(wrapper);
  }

  function toolCard(
    data: {
      name: string;
      state: string;
      content?: MessageContent;
      arguments?: unknown;
      sessionId?: string;
      id?: string;
      taskId?: string;
      elapsedMs?: number;
      approvalMs?: number;
      exitCode?: number;
    },
    card?: HTMLDetailsElement,
  ) {
    const item = card ?? document.createElement('details');
    toolItems.set(item, data);
    item.className = 'tool-card ui-record ui-disclosure';
    item.dataset.state = data.state;
    const summary = document.createElement('summary');
    const name = document.createElement('strong');
    name.className = 'ui-record-label';
    name.textContent = data.name.replaceAll('_', ' ');
    name.title = data.name;
    const status = document.createElement('span');
    status.className = 'tool-state';
    const labels: Record<string, string> = {
      finished: 'Done',
      running: 'Running',
      approval: 'Waiting for approval',
      denied: 'Denied',
      skipped: 'Skipped',
      cancelled: 'Cancelled',
      error: 'Failed',
    };
    status.textContent =
      data.taskId && data.state === 'finished' ? 'Accepted' : (labels[data.state] ?? data.state);
    summary.append(icon('chevron'), name);
    const elapsed = data.elapsedMs;
    if (elapsed !== undefined && Number.isFinite(elapsed)) {
      const duration = document.createElement('span');
      duration.className = 'tool-duration';
      duration.textContent =
        elapsed < 1000 ? Math.round(elapsed) + ' ms' : (elapsed / 1000).toFixed(1) + ' s';
      if (data.approvalMs !== undefined)
        duration.title = 'Execution only. Approval took ' + Math.round(data.approvalMs) + ' ms.';
      summary.append(duration);
    }
    if (data.exitCode !== undefined && Number.isInteger(data.exitCode)) {
      const code = document.createElement('span');
      code.className = 'tool-exit-code';
      code.textContent = 'Exit ' + data.exitCode;
      if (data.exitCode !== 0) code.dataset.failed = 'true';
      summary.append(code);
    }
    summary.append(status);
    const body = document.createElement('div');
    body.className = 'tool-content';
    if (data.arguments !== undefined) {
      const args = document.createElement('pre');
      args.className = 'tool-arguments';
      args.textContent = JSON.stringify(data.arguments, null, 2);
      body.append(args);
    }
    resources.get(item)?.abort();
    const resource = new AbortController();
    resources.set(item, resource);
    const custom = extensions.render(data, resource.signal);
    if (custom) body.append(custom);
    const output = custom ? '' : textOf(data.content);
    if (output) {
      const result = document.createElement('pre');
      result.textContent = output;
      body.append(result);
    }
    for (const block of typeof data.content === 'string' ? [] : (data.content ?? [])) {
      if (block.type !== 'image' || !imageMime.test(block.mimeType ?? '') || !block.data) continue;
      const img = document.createElement('img');
      img.alt = 'Tool output';
      img.loading = 'lazy';
      img.src = 'data:' + block.mimeType + ';base64,' + block.data;
      body.append(img);
    }
    const action = extensions.render(data, resource.signal, true);
    if (action) {
      body.append(action);
    }
    const oldSummary = item.firstElementChild;
    const oldBody = item.lastElementChild;
    if (oldSummary && oldBody) {
      oldSummary.replaceChildren(...summary.children);
      oldBody.replaceWith(body);
    } else item.append(summary, body);
    return item;
  }

  function renderUser(message: Extract<ViewMessage, { role: 'user' }>) {
    const origin = message.origin;
    const notification = notificationLabel(origin, message.inboxId);
    const entry = document.createElement(notification ? 'details' : 'div');
    entry.className = notification ? 'async-message ui-record ui-disclosure' : 'message-row user';
    const text = textOf(message.content);
    const attachments = message.attachments ?? [];
    const bubble = document.createElement('article');
    bubble.className = notification ? 'async-message-body' : 'message user';
    if (notification) {
      const summary = document.createElement('summary');
      const sender = origin?.senderSessionId;
      const title = sender ? ctx.get('harnessBrowser')?.session(sender)?.title : undefined;
      const label = document.createElement('span');
      label.className = 'ui-record-label';
      label.textContent = notification + (title ? ' · ' + title : '');
      summary.append(icon('chevron'), label);
      entry.append(summary);
    }
    const list = document.createElement('div');
    list.className = 'message-attachments';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Attachments');
    const { workspaceId, sessionId } = current();
    for (const [index, file] of attachments.entries()) {
      const { id, data, name, mimeType } = file;
      const resource = !workspaceId
        ? undefined
        : id && sessionId
          ? { kind: 'attachment' as const, workspaceId, sessionId, id, name, mimeType }
          : data && {
              kind: 'memory' as const,
              workspaceId,
              key: message.id + ':' + index,
              data,
              name,
              mimeType,
              signal,
            };
      list.append(attachmentView(ctx, file, resource || undefined));
    }
    if (list.childElementCount) bubble.append(list);
    if (text) {
      const body = document.createElement('div');
      if (notification) renderMarkdown(body, text);
      else {
        body.className = 'user-text';
        renderReferences(body, text, (path) => {
          if (workspaceId)
            ctx.get('miniFilePreview')?.open({ kind: 'workspace', workspaceId, path }, 'sidebar');
        });
      }
      bubble.append(body);
    }
    entry.append(bubble);
    if (!notification) {
      entry.append(
        messageActions(entry, { type: 'user-message', message, rawText: text }, message.timestamp),
      );
      renderMessageActions(entry);
    }
    return entry;
  }

  function refreshTools(name: string) {
    for (const card of messages.querySelectorAll<HTMLDetailsElement>('details.tool-card')) {
      const tool = toolItems.get(card);
      if (tool?.name === name) toolCard(tool, card);
    }
  }

  function remove(node: HTMLElement) {
    resources.get(node)?.abort();
    resources.delete(node);
    node.remove();
  }

  function reconcile(target: HTMLElement, nodes: HTMLElement[]) {
    const kept = new Set(nodes);
    for (const child of [...target.children]) if (!kept.has(child as HTMLElement)) child.remove();
    for (const [index, node] of nodes.entries())
      if (target.children[index] !== node) target.insertBefore(node, target.children[index] ?? null);
  }

  function terminalNode(run: RunTermination, retry: boolean) {
    const node = document.createElement('div');
    node.className = 'run-termination';
    node.dataset.state = run.state;
    const label = document.createElement('div');
    label.className = run.state === 'failed' ? 'message error' : 'hint';
    const seconds = (Date.parse(run.finishedAt ?? '') - Date.parse(run.startedAt)) / 1000;
    label.textContent =
      run.state === 'failed'
        ? 'Run failed' + (run.error ? ': ' + run.error : '')
        : run.state === 'interrupted' || run.error === 'Interrupted by a new message'
          ? 'Run interrupted'
          : 'Run cancelled' + (seconds >= 1 ? ' after ' + Math.round(seconds) + ' s' : '');
    node.append(label);
    if (retry) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-button';
      button.textContent = 'Retry';
      button.onclick = retryLast;
      node.append(button);
    }
    return node;
  }

  function reset() {
    for (const node of resources.keys()) remove(node);
    messages.replaceChildren();
    nodes.clear();
    follow();
  }

  function follow() {
    following = true;
    scrollToEnd();
  }

  function history(
    entries: readonly HistoryEntry[],
    run: RunInfo | undefined,
    partial: string,
    tools: Parameters<typeof groupHistory>[3],
    records: readonly LiveRecord[],
  ) {
    const pending = new Set(nodes.keys());
    const progressKey = (runId: string | undefined, callId: string) =>
      'tool-progress:' + JSON.stringify([runId, callId]);
    function retain<T extends HTMLElement>(key: string, source: unknown, render: (prior?: T) => T) {
      pending.delete(key);
      const prior = nodes.get(key);
      if (prior && prior.source === source) return prior.node as T;
      const node = render(prior?.node as T | undefined);
      nodes.set(key, { node, source });
      return node;
    }

    function record(entry: LiveRecord) {
      const render = extensions.recordRenderer(entry.plugin, entry.kind);
      const node = retain('record:' + entry.id, render, (previous) => {
        if (previous) remove(previous);
        const lifetime = new AbortController();
        const node = document.createElement('div');
        node.className = 'conversation-record';
        node.dataset.conversationRecord = entry.id;
        resources.set(node, lifetime);
        const shown = extensions.renderRecord(render, entry, {
          sessionId: current().sessionId!,
          signal: lifetime.signal,
        });
        if (shown) {
          node.append(shown.node);
          recordUpdates.set(node, shown.update);
        } else {
          const label = document.createElement('p');
          label.className = 'hint';
          label.textContent = entry.title;
          node.append(label);
          recordUpdates.set(node, (next) => {
            label.textContent = next.title;
          });
        }
        return node;
      });
      recordUpdates.get(node)!(entry);
      return node;
    }

    function renderPart(
      part: Extract<ReturnType<typeof groupHistory>[number], { type: 'turn' }>['parts'][number],
    ) {
      switch (part.type) {
        case 'record':
          return record(part);
        case 'message':
          return retain('tool-result:' + part.id, part, (node?: HTMLDetailsElement) => {
            const key = progressKey(part.runId, part.toolCallId);
            const progress = nodes.get(key)?.node as HTMLDetailsElement | undefined;
            nodes.delete(key);
            return toolCard(
              {
                name: part.toolName,
                state: part.toolState,
                id: part.toolCallId,
                content: part.content,
                arguments: part.arguments,
                sessionId: part.sessionId,
                taskId: part.taskId,
                elapsedMs: part.elapsedMs,
                approvalMs: part.approvalMs,
                exitCode: part.exitCode,
              },
              node ?? progress,
            );
          });
        case 'tool':
          return retain(progressKey(run?.id, part.id), part, (node?: HTMLDetailsElement) =>
            toolCard(part, node),
          );
        case 'partial':
          preview.textContent = partial;
          return preview;
        default:
          return retain(part.type + ':' + part.id, part.text, (previous) => {
            const node = previous ?? document.createElement('div');
            node.className = part.type === 'error' ? 'message error' : 'message assistant';
            if (part.type === 'error') node.textContent = part.text;
            else renderMarkdown(node, part.text);
            return node;
          });
      }
    }

    const desired = groupHistory(entries, run?.id, partial, tools, records).map((row) => {
      switch (row.type) {
        case 'record':
          return record(row);
        case 'termination': {
          const retry = run?.id === row.id && run.state === 'failed';
          return retain('run:' + row.id, retry, () => terminalNode(row, retry));
        }
        case 'message':
          return retain('user:' + row.id, undefined, () => renderUser(row));
        case 'turn': {
          const wrapper = retain('turn:' + row.id, undefined, () => {
            const node = document.createElement('div');
            node.className = 'message-row assistant assistant-turn';
            return node;
          });
          const children = row.parts.map(renderPart);
          if (row.target) {
            children.push(messageActions(wrapper, row.target, row.target.messages.at(-1)!.timestamp));
            const { sessionId } = current();
            if (sessionId) {
              let rendered = footers.get(wrapper);
              if (!rendered) footers.set(wrapper, (rendered = new Map()));
              for (const render of extensions.turnFooters()) {
                let node = rendered.get(render);
                if (!node) {
                  const lifetime = new AbortController();
                  const context = { sessionId, messageId: row.target.id, signal: lifetime.signal };
                  try {
                    node = render(context);
                    rendered.set(render, node);
                    resources.set(node, lifetime);
                  } catch (error) {
                    lifetime.abort();
                    extensions.report(error);
                    continue;
                  }
                }
                children.push(node);
              }
              for (const [render, node] of rendered) if (!children.includes(node)) rendered.delete(render);
            }
          }
          reconcile(wrapper, children);
          return wrapper;
        }
      }
    });

    for (const key of pending) nodes.delete(key);
    reconcile(messages, desired);
    for (const node of resources.keys()) if (!messages.contains(node)) remove(node);
    refreshActions();
    scrollToEnd();
  }

  return {
    history,
    reset,
    follow,
    refreshTools,
    refreshActions,
    partial(text: string) {
      if (!text || !messages.contains(preview)) return false;
      preview.textContent = text;
      scrollToEnd();
      return true;
    },
  };
}
