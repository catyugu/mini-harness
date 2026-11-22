import type { MessageContent, RunEvent, ViewMessage } from '../src/protocol.js';
import type { ConversationView } from './types.js';
import type { FrontendHost } from './extensions.js';
import { icon } from './icons.js';
import { renderMarkdown, markdownSource } from './markdown.js';

export function createMessageView(messages: HTMLElement, extensions: Pick<FrontendHost, 'render'>,
  retryLast: () => void, editMessage: (text: string) => void) {
const toolItems = new WeakMap<HTMLDetailsElement, Parameters<typeof toolCard>[0]>();
const toolDurations = new Map<string, number>();

function textOf(value?: MessageContent) {
  if (typeof value === 'string') return value;
  return value?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

function addMessage(role: 'user' | 'assistant' | 'error', text: string, timestamp = Date.now()) {
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

  const copy = action('Copy message', 'copy', async () => {
    try {
      await navigator.clipboard.writeText(markdownSource.get(item) ?? item.textContent ?? '');
      copy.setAttribute('aria-label', 'Copied');
      copy.title = 'Copied';
    } catch {
      copy.setAttribute('aria-label', 'Copy failed');
      copy.title = 'Copy failed';
    }
  });
  actions.append(copy);
  if (role === 'user') actions.append(action('Edit message', 'edit', () => editMessage(text)));
  if (role === 'error') actions.append(action('Retry', 'refresh', retryLast));
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
  wrapper.append(actions);
  messages.append(wrapper);
  return item;
}

function toolCard(data: { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string; id?: string; elapsedMs?: number; exitCode?: number }, card?: HTMLDetailsElement) {
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
  status.textContent = data.state === 'finished' ? 'Done' : data.state === 'running' ? 'Running' : 'Failed';
  if (data.state === 'error' && item.dataset.renderedState !== 'error') item.open = true;
  item.dataset.renderedState = data.state;
  summary.append(icon('chevron'), name);
  if (data.elapsedMs !== undefined && data.id) {
    toolDurations.set(data.id, data.elapsedMs);
    if (toolDurations.size > 256) toolDurations.delete(toolDurations.keys().next().value);
  }
  const elapsed = data.elapsedMs ?? toolDurations.get(data.id);
  if (elapsed !== undefined && Number.isFinite(elapsed)) {
    const duration = document.createElement('span');
    duration.className = 'tool-duration';
    duration.textContent = elapsed < 1000 ? Math.round(elapsed) + ' ms' : (elapsed / 1000).toFixed(1) + ' s';
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
  const custom = extensions.render(data);
  if (custom) body.append(custom);
  if (data.arguments !== undefined) {
    const args = document.createElement('pre');
    args.className = 'tool-arguments';
    args.textContent = JSON.stringify(data.arguments, null, 2);
    body.append(args);
  }
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
    toolCard({ name: message.toolName ?? 'Tool', state: message.isError ? 'error' : 'finished',
      id: message.toolCallId, content: message.content, arguments: message.arguments, sessionId: message.sessionId,
      elapsedMs: message.elapsedMs, exitCode: message.exitCode });
    return;
  }
  const text = textOf(message.content);
  if (text) addMessage(message.role, text, message.timestamp);
  for (const block of typeof message.content === 'string' ? [] : message.content ?? []) {
    if (block.type !== 'image' || !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? '')) continue;
    const image = document.createElement('img'); image.className = 'message-image'; image.alt = 'Attached image';
    image.src = 'data:' + block.mimeType + ';base64,' + block.data; messages.append(image);
  }
  if (message.error) addMessage('error', message.error);
}

function refreshTools() {
  for (const card of messages.querySelectorAll<HTMLDetailsElement>('details.tool-card')) {
    toolCard(toolItems.get(card), card);
  }
}

function history(entries: ViewMessage[], error?: string) {
  messages.replaceChildren();
  for (const message of entries) appendHistory(message);
  if (error) {
    const node = [...messages.querySelectorAll<HTMLElement>('.message.error')].at(-1) ?? addMessage('error', '');
    node.textContent = error;
  }
  messages.scrollTop = messages.scrollHeight;
}

function stream(initial: ConversationView) {
  const cards = new Map<string, HTMLDetailsElement>();
  let answer: HTMLElement;
  let text: string;
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
        appendHistory({ role: 'user', content: event.content ?? event.text, timestamp: Date.now() });
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

return { textOf, history, stream, refreshTools };
}
