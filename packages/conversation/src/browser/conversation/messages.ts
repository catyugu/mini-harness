import type { Context } from 'cordis';
import type {} from '@mini-harness/ui-layout/browser/api';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { StreamEvent } from '@mini-harness/runs/stream';
import type { ToolView, MessageAction, MessageActionContext } from '../history-api.js';
import { icon } from '@mini-harness/ui-primitives/icons';
import { renderMarkdown } from '@mini-harness/ui-primitives/markdown';
import { button } from '@mini-harness/ui-primitives/primitives';

export function createMessageView(dialogs: Context['miniDialogs'], signal: AbortSignal, messages: HTMLElement,
  extensions: { render(tool: ToolView, signal: AbortSignal, action?: boolean): HTMLElement | undefined; messageActions(): MessageAction[]; report(error: unknown): void },
  current: () => { sessionId?: string; leafId?: string | null }, retryLast: () => void) {
const toolItems = new WeakMap<HTMLDetailsElement, Parameters<typeof toolCard>[0]>();
const resources = new Map<HTMLElement, AbortController>();
signal.addEventListener('abort', () => { for (const resource of resources.values()) resource.abort(); resources.clear(); }, { once: true });
const actionContext = new WeakMap<HTMLElement, Omit<MessageActionContext, 'signal'>>();
const actionOwners = new WeakMap<HTMLButtonElement, MessageAction>();
const saved = new Map<string, { node: HTMLElement; source: ViewMessage }>();
let previewAnswer: { node: HTMLElement; bubble: HTMLElement } | undefined;
const liveTools = new Map<string, HTMLDetailsElement>();
const imageMime = /^image\/(?:png|jpeg|gif|webp)$/;

const preview = document.createElement('figure');
preview.className = 'message-image-preview';
const previewViewport = document.createElement('div');
previewViewport.className = 'message-image-viewport';
previewViewport.setAttribute('role', 'region');
previewViewport.setAttribute('aria-label', 'Image');
const previewImage = document.createElement('img');
previewViewport.append(previewImage);
const caption = document.createElement('figcaption');
const filename = document.createElement('span');
const actualSize = button('Actual size', 'quiet');
caption.append(filename, actualSize);
preview.append(previewViewport, caption);
const { node: previewDialog, dispose } = dialogs.create('Image preview', preview);
signal.addEventListener('abort', dispose, { once: true });
previewDialog.classList.add('message-image-dialog');

function setActualSize(enabled: boolean) {
  actualSize.setAttribute('aria-pressed', String(enabled));
  previewViewport.classList.toggle('actual-size', enabled);
  previewViewport.tabIndex = enabled ? 0 : -1;
  previewViewport.scrollTo(0, 0);
}

actualSize.onclick = () => setActualSize(actualSize.getAttribute('aria-pressed') !== 'true');
previewDialog.addEventListener('close', () => {
  if (!previewDialog.open) previewImage.removeAttribute('src');
}, { signal: signal });

function openImage(thumbnail: HTMLImageElement) {
  previewImage.alt = filename.textContent = thumbnail.alt;
  previewImage.src = thumbnail.src;
  if (!previewDialog.open) previewDialog.showModal();
  setActualSize(false);
}

function textOf(value?: MessageContent) {
  if (typeof value === 'string') return value;
  return value?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

function updateTimestamp(time: HTMLTimeElement, timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime()) || time.dateTime === date.toISOString()) return;
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function addMessage(role: 'user' | 'assistant' | 'error', text: string, timestamp = Date.now(), source?: ViewMessage, target: HTMLElement = messages) {
  const item = document.createElement('article');
  item.className = 'message ' + role;
  if (role === 'assistant') renderMarkdown(item, text);
  else item.textContent = text;
  const wrapper = document.createElement('div');
  wrapper.className = 'message-row ' + role;
  wrapper.append(item);
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  actions.setAttribute('role', 'group');
  actions.setAttribute('aria-label', 'Message actions');
  wrapper.append(actions);

  function action(label: string, symbol: Parameters<typeof icon>[0], run: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'message-action';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(symbol));
    button.onclick = run;
    return button;
  }

  if (role === 'error') actions.append(action('Retry', 'refresh', retryLast));
  if (source) {
    const snapshot = current();
    actionContext.set(wrapper, {
      sessionId: snapshot.sessionId, leafId: snapshot.leafId, message: source, rawText: text
    });
    renderMessageActions(wrapper);
  }
  if (source && Number.isFinite(timestamp)) {
    const time = document.createElement('time');
    time.className = 'message-time';
    updateTimestamp(time, timestamp);
    actions.append(time);
  }
  target.append(wrapper);
  return item;
}

function renderMessageActions(wrapper: HTMLElement) {
  const group = wrapper.querySelector<HTMLElement>('.message-actions');
  const context = actionContext.get(wrapper);
  if (!group || !context) return;
  const available = new Map([...group.querySelectorAll<HTMLButtonElement>('[data-message-action]')]
    .map((button) => [button.dataset.messageAction, button]));
  const at = { ...context, ...current() };
  for (const extension of extensions.messageActions()) {
    const existing = available.get(extension.id);
    if (existing && actionOwners.get(existing) !== extension) remove(existing);
    const button = existing && actionOwners.get(existing) === extension ? existing : document.createElement('button');
    const lifetime = resources.get(button) ?? new AbortController();
    try {
      if (!extension.visible({ ...at, signal: lifetime.signal })) { lifetime.abort(); continue; }
    } catch (error) { lifetime.abort(); extensions.report(error); continue; }
    resources.set(button, lifetime);
    actionOwners.set(button, extension);
    available.delete(extension.id);
    button.type = 'button'; button.className = 'message-action';
    button.dataset.messageAction = extension.id;
    if (button.title !== extension.successLabel && !button.disabled) {
      button.title = extension.label;
      button.setAttribute('aria-label', extension.label);
    }
    if (!button.parentElement) button.append(icon(extension.icon));
    button.onclick = () => {
      button.disabled = true;
      const signal = lifetime.signal;
      void Promise.resolve().then(() => {
        signal.throwIfAborted();
        return extension.run({ ...(actionContext.get(wrapper) ?? context), ...current(), signal });
      }).then(() => {
        if (!signal.aborted && extension.successLabel) { button.title = extension.successLabel; button.setAttribute('aria-label', extension.successLabel); }
      }).catch((error) => {
        if (signal.aborted) return;
        button.title = error instanceof Error ? error.message : String(error);
        button.setAttribute('aria-label', 'Action failed: ' + button.title);
      }).finally(() => { button.disabled = false; });
    };
    if (!button.parentElement) group.append(button);
  }
  for (const button of available.values()) remove(button);

}

function refreshActions() {
  for (const wrapper of messages.querySelectorAll<HTMLElement>('.message-row')) renderMessageActions(wrapper);
}

function toolCard(data: { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string; id?: string; elapsedMs?: number; approvalMs?: number; exitCode?: number }, card?: HTMLDetailsElement, refresh = false) {
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
  const labels: Record<string, string> = { finished: 'Done', running: 'Running', approval: 'Waiting for approval', denied: 'Denied', error: 'Failed' };
  status.textContent = labels[data.state] ?? data.state;
  // Errors are visible in the summary, but details stay collapsed unless the user opens them.
  item.dataset.renderedState = data.state;
  summary.append(icon('chevron'), name);
  const elapsed = data.elapsedMs;
  if (elapsed !== undefined && Number.isFinite(elapsed)) {
    const duration = document.createElement('span');
    duration.className = 'tool-duration';
    duration.textContent = elapsed < 1000 ? Math.round(elapsed) + ' ms' : (elapsed / 1000).toFixed(1) + ' s';
    if (data.approvalMs !== undefined) duration.title = 'Execution only. Approval took ' + Math.round(data.approvalMs) + ' ms.';
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
  for (const block of typeof data.content === 'string' ? [] : data.content ?? []) {
    if (block.type !== 'image' || !imageMime.test(block.mimeType ?? '') || !block.data) continue;
    const img = document.createElement('img');
    img.alt = 'Tool output';
    img.loading = 'lazy';
    img.src = 'data:' + block.mimeType + ';base64,' + block.data;
    body.append(img);
  }
  const action = extensions.render(data, resource.signal, true);
  if (action) { action.dataset.toolExtension = 'true'; body.append(action); }
  const oldSummary = item.firstElementChild;
  const oldBody = item.lastElementChild;
  if (oldSummary && oldBody) {
    reconcileChildren(oldSummary, summary);
    reconcileChildren(oldBody, body);
  } else item.append(summary, body);
  return item;
}

function reconcileChildren(current: Element, updated: Element) {
  const existing = [...current.children], desired = [...updated.children];
  for (const [index, fresh] of desired.entries()) {
    const old = existing[index];
    if (!old) current.append(fresh);
    else if (!old.isEqualNode(fresh) || fresh.hasAttribute('data-tool-extension')) old.replaceWith(fresh);
  }
  for (const extra of existing.slice(desired.length)) extra.remove();
}

function renderEntry(message: ViewMessage, node?: HTMLElement) {
  if (message.role === 'toolResult') {
    return toolCard({ name: message.toolName ?? 'Tool', state: message.approvalDenied ? 'denied' : message.isError ? 'error' : 'finished',
      id: message.toolCallId, content: message.content, arguments: message.arguments, sessionId: message.sessionId,
      elapsedMs: message.elapsedMs, approvalMs: message.approvalMs, exitCode: message.exitCode }, node as HTMLDetailsElement | undefined);
  }
  const entry = document.createElement('div');
  entry.className = 'message-entry';
  const text = textOf(message.content);
  const blocks = typeof message.content === 'string' ? [] : message.content;
  const images = blocks.filter((block) => block.type === 'image' && imageMime.test(block.mimeType ?? '') && block.data);
  const attachments = message.attachments ?? [];
  if (text || images.length || attachments.length) {
    const bubble = addMessage(message.role, text, message.timestamp, message, entry);
    const imageFiles = attachments.filter(({ mimeType }) => imageMime.test(mimeType));
    const files = new Set(attachments);
    if (images.length) {
      const thumbnails = document.createElement('div');
      thumbnails.className = 'message-images';
      for (const [index, block] of images.entries()) {
        const attachment = imageFiles[index];
        const image = document.createElement('img');
        image.alt = attachment?.name ?? 'Attached image ' + (index + 1);
        image.loading = 'lazy';
        image.src = 'data:' + block.mimeType + ';base64,' + block.data;
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'message-image-trigger';
        trigger.setAttribute('aria-label', 'Preview ' + image.alt);
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.title = 'Preview ' + image.alt;
        trigger.append(image);
        trigger.onclick = () => openImage(image);
        thumbnails.append(trigger);
        if (attachment) files.delete(attachment);
      }
      if (text || files.size) thumbnails.classList.add('with-content');
      bubble.prepend(thumbnails);
    }
    if (files.size) {
      const list = document.createElement('ul');
      list.className = 'message-attachments';
      list.setAttribute('aria-label', 'Attachments');
      for (const { name } of files) {
        const item = document.createElement('li');
        item.textContent = name;
        list.append(item);
      }
      bubble.append(list);
    }
  }
  if (message.error) addMessage('error', message.error, undefined, undefined, entry);
  return entry;
}

function refreshTools(name: string) {
  for (const card of messages.querySelectorAll<HTMLDetailsElement>('details.tool-card')) {
    const tool = toolItems.get(card);
    if (tool?.name === name) toolCard(tool, card, true);
  }
}

function preserveScroll(update: () => void, reset = false) {
  const pinned = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 96;
  const top = messages.getBoundingClientRect().top;
  const visible = !reset && !pinned && [...messages.querySelectorAll<HTMLElement>('.message-row, .tool-card')]
    .find((node) => node.getBoundingClientRect().bottom > top);
  const offset = visible ? visible.getBoundingClientRect().top : 0;
  update();
  if (reset || pinned) messages.scrollTop = messages.scrollHeight;
  else if (visible && visible.isConnected) messages.scrollTop += visible.getBoundingClientRect().top - offset;
}

function remove(node: HTMLElement) {
  for (const button of node.querySelectorAll<HTMLElement>('[data-message-action]')) {
    resources.get(button)?.abort();
    resources.delete(button);
  }
  resources.get(node)?.abort();
  resources.delete(node);
  node.remove();
}

function history(entries: readonly ViewMessage[], records: readonly { record: SessionDisplayRecord; node: HTMLElement }[], error?: string, reset = false) {
  preserveScroll(() => {
    if (reset) {
      previewDialog.close();
      for (const node of resources.keys()) remove(node);
      messages.replaceChildren();
      saved.clear();
      liveTools.clear();
      previewAnswer = undefined;
    }
    const desired: HTMLElement[] = [];
    const anchors = new Map<string | null, HTMLElement[]>();
    for (const { record, node } of records) {
      const list = anchors.get(record.afterMessageId ?? null) ?? [];
      list.push(node);
      anchors.set(record.afterMessageId ?? null, list);
    }
    const place = (key: string | null) => {
      desired.push(...anchors.get(key) ?? []);
      anchors.delete(key);
    };
    place(null);
    const currentEntries = new Set<string>();
    for (const [index, message] of entries.entries()) {
      const key = message.id ?? message.role + ':' + index;
      const prior = saved.get(key);
      if (message.role === 'toolResult' || textOf(message.content) || message.attachments?.length ||
          message.error || (Array.isArray(message.content) && message.content.some(({ type }) => type === 'image'))) {
        let node = prior?.node;
        if (message.role === 'toolResult') {
          const tool = message.toolCallId && liveTools.get(message.toolCallId);
          node = renderEntry(message, node ?? (tool || undefined));
          if (message.toolCallId) liveTools.delete(message.toolCallId);
        } else if (!node || prior?.source !== message && JSON.stringify(prior?.source) !== JSON.stringify(message)) {
          const text = textOf(message.content);
          if (index === entries.length - 1 && message.role === 'assistant' && !message.error && previewAnswer &&
              text.startsWith(previewAnswer.bubble.textContent ?? '') && !message.attachments?.length) {
            const { node: previewNode, bubble } = previewAnswer;
            renderMarkdown(bubble, text);
            const row = bubble.parentElement!;
            actionContext.set(row, { ...current(), message, rawText: text });
            const time = document.createElement('time');
            time.className = 'message-time';
            updateTimestamp(time, message.timestamp);
            row.querySelector('.message-actions')?.append(time);
            renderMessageActions(row);
            node = previewNode;
            previewAnswer = undefined;
          } else node = renderEntry(message);
        }
        saved.set(key, { node, source: message });
        currentEntries.add(key);
        desired.push(node);
      }
      if (message.id) place(message.id);
    }
    for (const nodes of anchors.values()) desired.push(...nodes);
    for (const key of saved.keys()) if (!currentEntries.has(key)) saved.delete(key);
    if (error && !entries.some((entry) => entry.error === error)) {
      const previous = messages.querySelector<HTMLElement>('[data-run-error]');
      const node = previous?.querySelector('.message.error')?.textContent === error ? previous : errorEntry(error);
      node.dataset.runError = '';
      desired.push(node);
    }
    if (previewAnswer) desired.push(previewAnswer.node);
    desired.push(...liveTools.values());
    const kept = new Set(desired);
    for (const child of [...messages.children]) if (child instanceof HTMLElement && !kept.has(child)) remove(child);
    for (const [index, node] of desired.entries())
      if (messages.children[index] !== node) messages.insertBefore(node, messages.children[index] ?? null);
  }, reset);
}

function errorEntry(error: string) {
  const container = document.createElement('div');
  const bubble = addMessage('error', error, undefined, undefined, container);
  return bubble.parentElement!;
}

function partial(text: string) {
  if (!text && !previewAnswer) return;
  preserveScroll(() => {
    if (!text) { previewAnswer?.node.remove(); previewAnswer = undefined; return; }
    if (!previewAnswer) {
      const node = document.createElement('div');
      node.className = 'message-entry';
      previewAnswer = { node, bubble: addMessage('assistant', '', undefined, undefined, node) };
      messages.insertBefore(node, liveTools.values().next().value ?? null);
    }
    previewAnswer.bubble.textContent = text;
  });
}

function activity(tools: readonly Extract<StreamEvent, { type: 'tool' }>[]) {
  preserveScroll(() => {
    const active = new Set(tools.map(({ id }) => id));
    for (const [id, card] of liveTools) if (!active.has(id)) { remove(card); liveTools.delete(id); }
    for (const tool of tools) {
      const card = toolCard(tool, liveTools.get(tool.id));
      if (!liveTools.has(tool.id)) messages.append(card);
      liveTools.set(tool.id, card);
    }
  });
}

return { history, partial, activity, refreshTools, refreshActions };
}
