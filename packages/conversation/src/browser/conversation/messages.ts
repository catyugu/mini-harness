import { layoutExtensions } from '@mini-harness/ui-layout/browser/api';
import type { SessionDisplayRecord } from '@mini-harness/sessions/display-record';
import type { MessageContent, ViewMessage } from '@mini-harness/sessions/message';
import type { RunEvent } from '@mini-harness/runs/stream';
import type { ConversationView } from '../../shared/api.js';
import type { FrontendApi } from '@mini-harness/ui-runtime/frontend-api';
import type { ToolView, MessageAction, MessageActionContext } from '../composer-api.js';
import { icon } from '@mini-harness/ui-primitives/icons';
import { renderMarkdown, markdownSource } from '@mini-harness/ui-primitives/markdown';
import { button } from '@mini-harness/ui-primitives/primitives';

export function createMessageView(api: Pick<FrontendApi, 'contribute' | 'signal'>, messages: HTMLElement,
  extensions: { render(tool: ToolView, action?: boolean): HTMLElement | undefined; messageActions(): MessageAction[] },
  current: () => { sessionId?: string; leafId?: string | null }, retryLast: () => void) {
const toolItems = new WeakMap<HTMLDetailsElement, Parameters<typeof toolCard>[0]>();
const actionContext = new WeakMap<HTMLElement, MessageActionContext>();
const saved = new Map<string, { node: HTMLElement; signature?: string }>();
const liveTools = new Map<string, HTMLDetailsElement>();
const runError = 'run-error';
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
const previewDialog = api.contribute(layoutExtensions.dialog, 'Image preview', preview);
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
}, { signal: api.signal });

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
  if (role !== 'error') {
    const snapshot = current();
    const message = source ?? { role, content: text, timestamp };
    actionContext.set(wrapper, {
      sessionId: snapshot.sessionId, leafId: snapshot.leafId, message: message as ViewMessage, rawText: text
    });
    renderMessageActions(wrapper);
  }
  if (role !== 'error' && Number.isFinite(timestamp)) {
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
    if (!extension.visible(at)) continue;
    const existing = available.get(extension.id);
    const button = existing ?? document.createElement('button');
    available.delete(extension.id);
    button.type = 'button'; button.className = 'message-action';
    button.dataset.messageAction = extension.id;
    if (!existing || (button.title !== extension.successLabel && !button.disabled)) {
      button.title = extension.label;
      button.setAttribute('aria-label', extension.label);
    }
    if (!existing) button.append(icon(extension.icon));
    button.onclick = () => {
      button.disabled = true;
      void Promise.resolve().then(() => extension.run({ ...(actionContext.get(wrapper) ?? context), ...current() })).then(() => {
        if (extension.successLabel) { button.title = extension.successLabel; button.setAttribute('aria-label', extension.successLabel); }
      }).catch((error) => {
        button.title = error instanceof Error ? error.message : String(error);
        button.setAttribute('aria-label', 'Action failed: ' + button.title);
      }).finally(() => { button.disabled = false; });
    };
    if (!existing) group.append(button);
  }
  for (const button of available.values()) button.remove();
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
  const custom = extensions.render(data);
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
  const action = extensions.render(data, true);
  if (action) { action.dataset.toolExtension = 'true'; body.append(action); }
  const oldSummary = item.firstElementChild;
  const oldBody = item.lastElementChild;
  if (oldSummary && oldBody) {
    reconcileChildren(oldSummary, summary);
    reconcileChildren(oldBody, body, refresh);
  } else item.append(summary, body);
  return item;
}

function reconcileChildren(current: Element, updated: Element, refresh = false) {
  const existing = [...current.children], desired = [...updated.children];
  for (const [index, fresh] of desired.entries()) {
    const old = existing[index];
    if (!old) current.append(fresh);
    else if (!old.isEqualNode(fresh) || refresh && fresh.hasAttribute('data-tool-extension')) old.replaceWith(fresh);
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

function refreshTools() {
  for (const card of messages.querySelectorAll<HTMLDetailsElement>('details.tool-card')) {
    const tool = toolItems.get(card);
    if (tool) toolCard(tool, card, true);
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

function history(entries: ViewMessage[], error?: string, reset = false) {
  preserveScroll(() => {
    if (reset) { previewDialog.close(); messages.replaceChildren(); saved.clear(); liveTools.clear(); }
    const nodes = entries.flatMap((message, index) => {
      if (message.role !== 'toolResult' && !textOf(message.content) && !message.attachments?.length &&
          !message.error && !(Array.isArray(message.content) && message.content.some((part) => part.type === 'image'))) return [];
      const key = message.id ?? message.role + ':' + index;
      const signature = JSON.stringify([message.role, message.content, message.attachments, message.error]);
      const prior = saved.get(key);
      let node = prior?.node;
      if (message.role === 'toolResult') {
        node = renderEntry(message, node ?? (message.toolCallId ? liveTools.get(message.toolCallId) : undefined));
      } else if (node && prior?.signature === undefined && message.role === 'assistant' && !message.error) {
        const bubble = node.querySelector<HTMLElement>('.message.assistant');
        if (bubble && markdownSource.get(bubble) !== textOf(message.content)) renderMarkdown(bubble, textOf(message.content));
      } else if (!node || prior?.signature !== signature) {
        node = renderEntry(message);
      }
      if (!node) return [];
      const row = node.querySelector<HTMLElement>('.message-row');
      if (row && message.role !== 'toolResult') {
        actionContext.set(row, { ...current(), message, rawText: textOf(message.content) });
        const time = row.querySelector<HTMLTimeElement>('time');
        if (time) updateTimestamp(time, message.timestamp);
        renderMessageActions(row);
      }
      saved.set(key, { node, signature });
      return [{ key, node }];
    });
    if (error && !entries.some((entry) => entry.error === error)) {
      const node = saved.get(runError)?.node ?? errorEntry(error);
      const bubble = node.querySelector('.message.error');
      if (bubble && bubble.textContent !== error) bubble.textContent = error;
      saved.set(runError, { node });
      nodes.push({ key: runError, node });
    }
    const keys = new Set(nodes.map(({ key }) => key));
    const kept = new Set(nodes.map(({ node }) => node));
    for (const key of saved.keys()) if (!keys.has(key)) saved.delete(key);
    for (const element of [...messages.children]) if (!kept.has(element as HTMLElement)) element.remove();
    let next = messages.firstElementChild;
    for (const { node } of nodes) {
      if (node !== next) messages.insertBefore(node, next);
      next = node.nextElementSibling;
    }
    liveTools.clear();
  }, reset);
}

/** Insert business nodes in the branch, without discarding the live response or tool cards. */
function placeRecords(records: { record: SessionDisplayRecord; node: HTMLElement }[], entries: ViewMessage[]) {
  preserveScroll(() => {
    for (const node of messages.querySelectorAll('[data-conversation-record]')) node.remove();
    const positions = new Map<string, HTMLElement | undefined>();
    let previous: HTMLElement | undefined;
    for (const { id } of entries) {
      if (!id) continue;
      const node = saved.get(id)?.node;
      if (node?.parentElement === messages) previous = node;
      positions.set(id, previous);
    }
    const placed = new Map<HTMLElement | undefined, HTMLElement>();
    for (const { record, node } of records) {
      node.dataset.conversationRecord = record.id;
      const anchor = record.afterMessageId ? positions.get(record.afterMessageId) : undefined;
      const tail = placed.get(anchor) ?? anchor;
      if (tail) tail.after(node);
      else messages.prepend(node);
      placed.set(anchor, node);
    }
  });
}

function errorEntry(error: string) {
  const container = document.createElement('div');
  const bubble = addMessage('error', error, undefined, undefined, container);
  return bubble.parentElement!;
}

function stream(initial: ConversationView) {
  let answer: HTMLElement | undefined;
  let text = '';
  function live({ partial, tools }: Pick<Extract<RunEvent, { type: 'snapshot' }>, 'partial' | 'tools'>) {
    text = partial ?? '';
    answer = text ? addMessage('assistant', text) : undefined;
    for (const tool of tools ?? []) {
      const card = toolCard(tool);
      liveTools.set(tool.id, card);
      messages.append(card);
    }
  }
  function finish() {
    if (answer && markdownSource.get(answer) !== text) renderMarkdown(answer, text);
    else if (answer && !answer.querySelector('*') && text) renderMarkdown(answer, text);
  }
  preserveScroll(() => live(initial));
  return (event: RunEvent) => preserveScroll(() => {
    switch (event.type) {
      case 'user': {
        const message: ViewMessage = { id: event.id, role: 'user', content: event.content, attachments: event.attachments,
          timestamp: event.timestamp ?? Date.now() };
        if (event.id && saved.has(event.id)) break;
        const node = renderEntry(message);
        if (event.id) saved.set(event.id, { node, signature: JSON.stringify([message.role, message.content, message.attachments, message.error]) });
        messages.append(node);
        break;
      }
      case 'assistant-start':
        answer = undefined;
        text = '';
        break;
      case 'delta':
        answer ??= addMessage('assistant', '');
        text += event.text;
        answer.textContent = text;
        const row = answer.parentElement;
        const context = row && actionContext.get(row);
        if (row && context) actionContext.set(row, { ...context, rawText: text, message: { ...context.message, content: text } });
        break;
      case 'assistant-end': {
        finish();
        const node = answer?.parentElement;
        if (event.id && node) saved.set(event.id, { node });
        break;
      }
      case 'tool': {
        const existing = liveTools.get(event.id);
        const card = toolCard(event, existing);
        liveTools.set(event.id, card);
        if (!existing) messages.append(card);
        break;
      }
      case 'error': {
        const node = errorEntry(event.error);
        saved.set(runError, { node });
        messages.append(node);
        break;
      }
      case 'snapshot':
        history(event.messages, event.run.error);
        live(event);
        break;
    }
  });
}

return { textOf, history, stream, placeRecords, refreshTools, refreshActions };
}
