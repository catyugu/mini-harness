import type { MessageContent, ViewMessage } from '@mini-harness/contracts/message';
import type { RunEvent } from '@mini-harness/contracts/transport';
import type { ConversationView } from '@mini-harness/web/types';
import type { ToolView, MessageAction } from '@mini-harness/ui-runtime/frontend';
import { icon } from '@mini-harness/ui-primitives/icons';
import { renderMarkdown, markdownSource } from '@mini-harness/ui-primitives/markdown';
import type { MessageActionContext } from '@mini-harness/ui-runtime/frontend';

export function createMessageView(messages: HTMLElement, extensions: { render(tool: ToolView, action?: boolean): HTMLElement | undefined; messageActions(): MessageAction[] },
  current: () => { sessionId?: string; leafId?: string | null }, retryLast: () => void) {
const toolItems = new WeakMap<HTMLDetailsElement, Parameters<typeof toolCard>[0]>();
const toolDurations = new Map<string, number>();
const actionContext = new Map<HTMLElement, MessageActionContext>();

function textOf(value?: MessageContent) {
  if (typeof value === 'string') return value;
  return value?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

function addMessage(role: 'user' | 'assistant' | 'error', text: string, timestamp = Date.now(), source?: ViewMessage) {
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
    const date = new Date(timestamp);
    if (!Number.isNaN(date.getTime())) {
      const time = document.createElement('time');
      time.className = 'message-time';
      time.dateTime = date.toISOString();
      time.textContent = date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      actions.append(time);
    }
  }
  messages.append(wrapper);
  return item;
}

function renderMessageActions(wrapper: HTMLElement) {
  const group = wrapper.querySelector<HTMLElement>('.message-actions');
  const context = actionContext.get(wrapper);
  if (!group || !context) return;
  // Only replace contributed buttons; preserve the timestamp and other host controls.
  group.querySelectorAll('[data-message-action]').forEach((node) => node.remove());
  for (const extension of extensions.messageActions()) {
    if (!extension.visible(context)) continue;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'message-action';
    button.dataset.messageAction = extension.id;
    button.title = extension.label; button.setAttribute('aria-label', extension.label);
    button.append(icon(extension.icon));
    button.onclick = () => {
      button.disabled = true;
      void Promise.resolve().then(() => extension.run(context)).then(() => {
        if (extension.successLabel) { button.title = extension.successLabel; button.setAttribute('aria-label', extension.successLabel); }
      }).catch((error) => {
        button.title = error instanceof Error ? error.message : String(error);
        button.setAttribute('aria-label', 'Action failed: ' + button.title);
      }).finally(() => { button.disabled = false; });
    };
    group.append(button);
  }
}

function refreshActions() {
  for (const wrapper of messages.querySelectorAll<HTMLElement>('.message-row')) renderMessageActions(wrapper);
}

function toolCard(data: { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string; id?: string; elapsedMs?: number; approvalMs?: number; exitCode?: number }, card?: HTMLDetailsElement) {
  const item = card ?? document.createElement('details');
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
  if (data.elapsedMs !== undefined && data.id) {
    toolDurations.set(data.id, data.elapsedMs);
    if (toolDurations.size > 256) {
      const oldest = toolDurations.keys().next().value;
      if (oldest !== undefined) toolDurations.delete(oldest);
    }
  }
  const elapsed = data.elapsedMs ?? (data.id ? toolDurations.get(data.id) : undefined);
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
  if (custom) body.append(custom);
  const output = custom ? '' : textOf(data.content);
  if (output) {
    const result = document.createElement('pre');
    result.textContent = output;
    body.append(result);
  }
  for (const block of typeof data.content === 'string' ? [] : data.content ?? []) {
    if (block.type !== 'image' || !/^image\/(?:png|jpeg|gif|webp)$/.test(block.mimeType ?? '') || !block.data) continue;
    const img = document.createElement('img');
    img.alt = 'Tool output';
    img.loading = 'lazy';
    img.src = 'data:' + block.mimeType + ';base64,' + block.data;
    body.append(img);
  }
  const action = extensions.render(data, true);
  if (action) body.append(action);
  item.replaceChildren(summary, body);
  if (!card) messages.append(item);
  return item;
}

function appendHistory(message: ViewMessage) {
  if (message.role === 'toolResult') {
    toolCard({ name: message.toolName ?? 'Tool', state: message.approvalDenied ? 'denied' : message.isError ? 'error' : 'finished',
      id: message.toolCallId, content: message.content, arguments: message.arguments, sessionId: message.sessionId,
      elapsedMs: message.elapsedMs, approvalMs: message.approvalMs, exitCode: message.exitCode });
    return;
  }
  const text = textOf(message.content);
  const bubble = text || message.attachments?.length ? addMessage(message.role, text, message.timestamp, message) : undefined;
  for (const block of typeof message.content === 'string' ? [] : message.content ?? []) {
    if (block.type !== 'image' || !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? '')) continue;
    const image = document.createElement('img'); image.className = 'message-image'; image.alt = 'Attached image';
    image.src = 'data:' + block.mimeType + ';base64,' + block.data; messages.append(image);
  }
  if (message.attachments?.length && bubble) {
    const list = document.createElement('ul');
    list.className = 'message-attachments';
    list.setAttribute('aria-label', 'Attachments');
    for (const attachment of message.attachments) {
      const item = document.createElement('li');
      item.textContent = attachment.name;
      list.append(item);
    }
    bubble.append(list);
  }
  if (message.error) addMessage('error', message.error);
}

function refreshTools() {
  for (const card of messages.querySelectorAll<HTMLDetailsElement>('details.tool-card')) {
    const tool = toolItems.get(card);
    if (tool) toolCard(tool, card);
  }
}

function history(entries: ViewMessage[], error?: string) {
  messages.replaceChildren();
  actionContext.clear();
  for (const message of entries) appendHistory(message);
  if (error) {
    const node = [...messages.querySelectorAll<HTMLElement>('.message.error')].at(-1) ?? addMessage('error', '');
    node.textContent = error;
  }
  messages.scrollTop = messages.scrollHeight;
}

function stream(initial: ConversationView) {
  const cards = new Map<string, HTMLDetailsElement>();
  let answer: HTMLElement | undefined;
  let text = '';
  function live({ partial, tools }: Pick<ConversationView, 'partial' | 'tools'>) {
    text = partial ?? '';
    answer = text ? addMessage('assistant', text) : undefined;
    cards.clear();
    for (const tool of tools ?? []) cards.set(tool.id, toolCard(tool));
  }
  function finish(output = text) {
    if (!output && !answer) return;
    answer ??= addMessage('assistant', '');
    renderMarkdown(answer, output);
  }
  live(initial);
  return (event: RunEvent) => {
    const pinned = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 96;
    switch (event.type) {
      case 'user':
        appendHistory({ role: 'user', content: event.content, attachments: event.attachments, timestamp: Date.now() });
        break;
      case 'assistant-start':
        finish();
        answer = undefined;
        text = '';
        break;
      case 'delta':
        answer ??= addMessage('assistant', '');
        text += event.text;
        answer.textContent = text;
        markdownSource.set(answer, text);
        break;
      case 'assistant-end': finish(); break;
      case 'complete': finish(event.text || text); break;
      case 'tool':
        finish();
        cards.set(event.id, toolCard(event, cards.get(event.id)));
        break;
      case 'error':
        finish();
        addMessage('error', event.error);
        break;
      case 'snapshot':
        history(event.messages, event.run.error);
        live(event);
        break;
    }
    if (pinned) messages.scrollTop = messages.scrollHeight;
  };
}

return { textOf, history, stream, refreshTools, refreshActions };
}
