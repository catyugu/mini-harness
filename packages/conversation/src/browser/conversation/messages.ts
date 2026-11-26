import type { Context } from 'mini-harness/cordis';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { RunInfo, RunTermination } from '@mini-harness/sessions/run-state';
import type { StreamEvent } from '@mini-harness/runs/stream';
import type { ToolView, MessageAction, MessageActionContext } from '../history-api.ts';
import { icon } from '@mini-harness/ui-primitives/icons';
import { renderMarkdown } from '@mini-harness/ui-primitives/markdown';
import { imageMime } from './attachment-card.ts';
import { attachmentView } from './attachment-view.ts';
import { renderReferences } from './file-references.ts';

export function createMessageView(
  ctx: Context,
  signal: AbortSignal,
  viewport: HTMLElement,
  messages: HTMLElement,
  extensions: {
    render(tool: ToolView, signal: AbortSignal, action?: boolean): HTMLElement | undefined;
    messageActions(): MessageAction[];
    report(error: unknown): void;
  },
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
  const actionContext = new WeakMap<HTMLElement, Omit<MessageActionContext, 'signal'>>();
  const actionOwners = new WeakMap<HTMLButtonElement, MessageAction>();
  const saved = new Map<string, { node: HTMLElement; source: ViewMessage }>();
  const turns = new Map<string, HTMLElement>();
  const markdown = new WeakMap<HTMLElement, string>();
  const preview = document.createElement('div');
  preview.className = 'message assistant';
  let following = true;

  const scrollToEnd = () => {
    if (following && viewport.clientHeight) viewport.scrollTop = viewport.scrollHeight;
  };
  viewport.addEventListener(
    'scroll',
    () => {
      if (viewport.clientHeight)
        following = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 8;
    },
    { signal },
  );
  const resize = new ResizeObserver(scrollToEnd);
  resize.observe(viewport);
  resize.observe(messages);
  signal.addEventListener('abort', () => resize.disconnect(), { once: true });
  const liveTools = new Map<string, HTMLDetailsElement>();

  function textOf(value?: MessageContent) {
    if (typeof value === 'string') return value;
    return (
      value
        ?.filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('\n') ?? ''
    );
  }

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

  function messageActions(wrapper: HTMLElement, message: ViewMessage, rawText: string) {
    actionContext.set(wrapper, { ...current(), message, rawText });
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
    updateTimestamp(time, message.timestamp);
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
    const at = { ...context, ...current() };
    for (const extension of extensions.messageActions()) {
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
            return extension.run({ ...(actionContext.get(wrapper) ?? context), ...current(), signal });
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
      elapsedMs?: number;
      approvalMs?: number;
      exitCode?: number;
    },
    card?: HTMLDetailsElement,
    refresh = false,
  ) {
    const item = card ?? document.createElement('details');
    const previous = toolItems.get(item);
    if (!refresh && previous && JSON.stringify(previous) === JSON.stringify(data)) return item;
    toolItems.set(item, data);
    item.className = 'tool-card';
    item.dataset.state = data.state;
    const summary = document.createElement('summary');
    const name = document.createElement('strong');
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
      error: 'Failed',
    };
    status.textContent = labels[data.state] ?? data.state;
    // Errors are visible in the summary, but details stay collapsed unless the user opens them.
    item.dataset.renderedState = data.state;
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
    if (custom) custom.dataset.toolExtension = 'true';
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
      action.dataset.toolExtension = 'true';
      body.append(action);
    }
    const oldSummary = item.firstElementChild;
    const oldBody = item.lastElementChild;
    if (oldSummary && oldBody) {
      reconcileChildren(oldSummary, summary);
      reconcileChildren(oldBody, body);
    } else item.append(summary, body);
    return item;
  }

  function reconcileChildren(current: Element, updated: Element) {
    const existing = [...current.children],
      desired = [...updated.children];
    for (const [index, fresh] of desired.entries()) {
      const old = existing[index];
      if (!old) current.append(fresh);
      else if (!old.isEqualNode(fresh) || fresh.hasAttribute('data-tool-extension')) old.replaceWith(fresh);
    }
    for (const extra of existing.slice(desired.length)) extra.remove();
  }

  function renderEntry(message: ViewMessage, node?: HTMLElement) {
    if (message.role === 'toolResult') {
      return toolCard(
        {
          name: message.toolName ?? 'Tool',
          state: message.toolState ?? 'finished',
          id: message.toolCallId,
          content: message.content,
          arguments: message.arguments,
          sessionId: message.sessionId,
          elapsedMs: message.elapsedMs,
          approvalMs: message.approvalMs,
          exitCode: message.exitCode,
        },
        node as HTMLDetailsElement | undefined,
      );
    }
    const entry = document.createElement('div');
    entry.className = 'message-row user';
    const text = textOf(message.content);
    const blocks = typeof message.content === 'string' ? [] : message.content;
    const images = blocks.filter(
      (block) => block.type === 'image' && imageMime.test(block.mimeType ?? '') && block.data,
    );
    const attachments = message.attachments ?? [];
    if (!text && !images.length && !attachments.length) return entry;
    const bubble = document.createElement('article');
    bubble.className = 'message user';
    const list = document.createElement('div');
    list.className = 'message-attachments';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Attachments');
    const { workspaceId, sessionId } = current();
    const remaining = [...images];
    const resource = new AbortController();
    resources.set(entry, resource);
    const signal = resource.signal;
    const memory = (image: (typeof images)[number], name: string, mimeType: string, key: string) =>
      workspaceId && image.data
        ? { kind: 'memory' as const, workspaceId, sessionId, key, name, mimeType, data: image.data, signal }
        : undefined;

    for (const [index, file] of attachments.entries()) {
      const image = imageMime.test(file.mimeType) ? remaining.shift() : undefined;
      const stored =
        file.id && workspaceId && sessionId
          ? { ...file, kind: 'attachment' as const, id: file.id, workspaceId, sessionId }
          : undefined;
      list.append(
        attachmentView(
          ctx,
          file,
          stored ?? (image && memory(image, file.name, file.mimeType, 'image:' + index)),
          signal,
          image?.data,
        ),
      );
    }
    for (const [index, image] of remaining.entries()) {
      const name = 'Attached image ' + (index + 1);
      const mimeType = image.mimeType!;
      list.append(
        attachmentView(ctx, { name, mimeType }, memory(image, name, mimeType, 'inline:' + index), signal),
      );
    }
    if (list.childElementCount) bubble.append(list);
    if (text) {
      const body = document.createElement('div');
      body.className = 'user-text';
      renderReferences(body, text, (path) => {
        if (workspaceId)
          ctx.get('miniFilePreview')?.open({ kind: 'workspace', workspaceId, path }, 'sidebar');
      });
      bubble.append(body);
    }
    entry.append(bubble, messageActions(entry, message, text));
    renderMessageActions(entry);
    return entry;
  }

  function refreshTools(name: string) {
    for (const card of messages.querySelectorAll<HTMLDetailsElement>('details.tool-card')) {
      const tool = toolItems.get(card);
      if (tool?.name === name) toolCard(tool, card, true);
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
        : run.state === 'interrupted'
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
      node.dataset.retry = '';
    }
    return node;
  }

  function history(
    entries: readonly ViewMessage[],
    records: readonly { record: SessionDisplayRecord; node: HTMLElement }[],
    terminations: readonly RunTermination[],
    run: RunInfo | undefined,
    partial: string,
    tools: readonly Extract<StreamEvent, { type: 'tool' }>[],
    reset: boolean,
  ) {
    if (reset) {
      following = true;
      for (const node of resources.keys()) remove(node);
      messages.replaceChildren();
      saved.clear();
      turns.clear();
      liveTools.clear();
    }
    const desired: HTMLElement[] = [];
    const activeMessages = new Set<string>();
    const activeTurns = new Set<string>();
    const anchors = new Map<string | null, (typeof records)[number][]>();
    const endings = new Map<string | null, RunTermination[]>();
    const failures = new Set(terminations.filter((item) => item.state === 'failed').map(({ id }) => id));
    const previousEndings = new Map(
      [...messages.querySelectorAll<HTMLElement>('[data-run-termination]')].map((node) => [
        node.dataset.runTermination,
        node,
      ]),
    );
    for (const item of records) {
      const key = item.record.afterMessageId ?? null;
      const list = anchors.get(key) ?? [];
      list.push(item);
      anchors.set(key, list);
    }
    for (const item of terminations) {
      const list = endings.get(item.afterEntryId) ?? [];
      list.push(item);
      endings.set(item.afterEntryId, list);
    }

    type Block = { key: string; text: string; type: 'text' | 'thinking' } | HTMLElement;
    type Turn = { key: string; runId?: string; blocks: Block[]; latest?: ViewMessage; copy: string[] };
    let turn: Turn | undefined;
    let boundary = '';
    const finish = () => {
      if (!turn) return;
      const { key, blocks, latest, copy } = turn;
      turn = undefined;
      if (!blocks.length) return;
      let wrapper = turns.get(key);
      if (!wrapper) {
        wrapper = document.createElement('div');
        wrapper.className = 'message-row assistant assistant-turn';
        turns.set(key, wrapper);
      }
      const prior = new Map(
        [...wrapper.children].map((child) => [
          (child as HTMLElement).dataset.assistantBlock,
          child as HTMLElement,
        ]),
      );
      const children = blocks.map((block) => {
        if (block instanceof HTMLElement) return block;
        let node = prior.get(block.key);
        if (!node) {
          node = document.createElement(block.type === 'thinking' ? 'details' : 'div');
          node.dataset.assistantBlock = block.key;
          if (block.type === 'thinking') {
            node.className = 'assistant-reasoning';
            const summary = document.createElement('summary');
            summary.textContent = 'Reasoning';
            node.append(summary, document.createElement('p'));
          } else node.className = 'message assistant';
        }
        if (markdown.get(node) !== block.text) {
          if (block.type === 'thinking') node.lastElementChild!.textContent = block.text;
          else renderMarkdown(node, block.text);
          markdown.set(node, block.text);
        }
        return node;
      });
      if (latest) children.push(messageActions(wrapper, latest, copy.join('\n\n')));
      reconcile(wrapper, children);
      if (latest) renderMessageActions(wrapper);
      desired.push(wrapper);
      activeTurns.add(key);
    };
    const assistant = (runId?: string) => {
      if (turn && turn.runId !== runId) finish();
      return (turn ??= { key: JSON.stringify([boundary, runId]), runId, blocks: [], copy: [] });
    };
    const placeEndings = (id: string | null) => {
      for (const item of endings.get(id) ?? []) {
        finish();
        const retry = run?.id === item.id && run.state === 'failed';
        const prior = previousEndings.get(item.id);
        const node = prior && prior.hasAttribute('data-retry') === retry ? prior : terminalNode(item, retry);
        node.dataset.runTermination = item.id;
        desired.push(node);
        boundary = item.id;
      }
    };
    const place = (id: string | null) => {
      placeEndings(id);
      for (const { record, node } of anchors.get(id) ?? []) {
        (turn?.blocks ?? desired).push(node);
        placeEndings(record.id);
      }
      anchors.delete(id);
    };
    place(null);
    for (const [index, message] of entries.entries()) {
      const key = message.id ?? message.role + ':' + index;
      const prior = saved.get(key);
      if (message.role === 'user') {
        finish();
        boundary = key;
        const same =
          prior && (prior.source === message || JSON.stringify(prior.source) === JSON.stringify(message));
        const node = same ? prior.node : renderEntry(message);
        if (node.childElementCount) desired.push(node);
        saved.set(key, { node, source: message });
        activeMessages.add(key);
      } else if (message.role === 'toolResult') {
        const tool = message.toolCallId && liveTools.get(message.toolCallId);
        const node = renderEntry(message, prior?.node ?? (tool || undefined));
        if (message.toolCallId) liveTools.delete(message.toolCallId);
        saved.set(key, { node, source: message });
        activeMessages.add(key);
        assistant(message.runId).blocks.push(node);
      } else {
        const group = assistant(message.runId);
        const parts =
          typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
        let previous = group.blocks.at(-1);
        let canMerge = true;
        for (const [partIndex, part] of parts.entries()) {
          if (part.type === 'text' && part.text) {
            if (canMerge && previous && !(previous instanceof HTMLElement) && previous.type === 'text')
              previous.text += (partIndex === 0 ? '\n\n' : '') + part.text;
            else {
              previous = { key: key + ':' + partIndex, text: part.text, type: 'text' };
              group.blocks.push(previous);
            }
            canMerge = true;
          } else if (part.type === 'thinking' && part.thinking && !part.redacted) {
            group.blocks.push({ key: key + ':' + partIndex, text: part.thinking, type: 'thinking' });
            canMerge = false;
          } else canMerge = false;
        }
        const body = textOf(message.content);
        if (body) group.copy.push(body);
        group.latest = message;
        if (message.error && !failures.has(message.runId ?? '')) {
          const error = document.createElement('div');
          error.className = 'message error';
          error.textContent = message.error;
          group.blocks.push(error);
        }
      }
      if (message.id) place(message.id);
    }
    if (partial) {
      preview.textContent = partial;
      assistant(run?.id).blocks.push(preview);
    }
    const activeTools = new Set(tools.map(({ id }) => id));
    for (const id of liveTools.keys()) if (!activeTools.has(id)) liveTools.delete(id);
    for (const tool of tools) {
      const card = toolCard(tool, liveTools.get(tool.id));
      liveTools.set(tool.id, card);
      assistant(run?.id).blocks.push(card);
    }
    for (const id of anchors.keys()) place(id);
    finish();
    for (const key of saved.keys()) if (!activeMessages.has(key)) saved.delete(key);
    for (const key of turns.keys()) if (!activeTurns.has(key)) turns.delete(key);
    reconcile(messages, desired);
    for (const node of resources.keys()) if (!messages.contains(node)) remove(node);
    scrollToEnd();
  }

  return {
    history,
    partial(text: string) {
      if (!text || !messages.contains(preview)) return false;
      preview.textContent = text;
      scrollToEnd();
      return true;
    },
    follow() {
      following = true;
      scrollToEnd();
    },
    refreshTools,
    refreshActions,
  };
}
