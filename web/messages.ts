import type { MessageContent, ViewMessage } from '../src/protocol.js';
import type { FrontendHost } from './extensions.js';
import { renderMarkdown } from './markdown.js';

export function createMessageView(messages: HTMLElement, extensions: FrontendHost, activate: (id: string) => void, retryLast: () => void) {
function textOf(value?: MessageContent) {
  if (typeof value === 'string') return value;
  return value?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

function addMessage(role: 'user' | 'assistant' | 'error', text: string) {
  const item = document.createElement('article');
  item.className = 'message ' + role;
  if (role === 'assistant') renderMarkdown(item, text);
  else item.textContent = text;
  const wrapper = document.createElement('div');
  wrapper.className = 'message-row ' + role;
  wrapper.append(item);
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  const copy = document.createElement('button');
  copy.type = 'button'; copy.className = 'link-button'; copy.textContent = 'Copy';
  copy.onclick = async () => { try { await navigator.clipboard.writeText(item.innerText); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; } };
  actions.append(copy);
  if (role === 'error') {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'link-button'; retry.textContent = 'Retry';
    retry.onclick = () => retryLast(); actions.append(retry);
  }
  wrapper.append(actions); messages.append(wrapper);
  return item;
}

function toolCard(data: { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string }, card?: HTMLDetailsElement) {
  const item = card ?? document.createElement('details');
  item.className = 'tool-card';
  item.dataset.state = data.state;
  const summary = document.createElement('summary');
  const name = document.createElement('strong');
  name.textContent = data.name;
  const status = document.createElement('span');
  status.textContent = data.state === 'finished' ? 'Done' : data.state === 'running' ? 'Running' : 'Failed';
  if (data.state === 'error') item.open = true;
  summary.append(name, status);
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
  if (data.sessionId && /^[a-f0-9-]{36}$/.test(data.sessionId)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.textContent = 'Open child conversation';
    button.onclick = () => void activate(data.sessionId);
    body.append(button);
  }
  item.replaceChildren(summary, body);
  if (!card) messages.append(item);
  return item;
}

function appendHistory(message: ViewMessage) {
  if (message.role === 'toolResult') {
    toolCard({ name: message.toolName ?? 'Tool', state: message.isError ? 'error' : 'finished',
      content: message.content, arguments: message.arguments, sessionId: message.sessionId });
    return;
  }
  const text = textOf(message.content);
  if (text) addMessage(message.role, text);
  for (const block of typeof message.content === 'string' ? [] : message.content ?? []) {
    if (block.type !== 'image' || !/^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? '')) continue;
    const image = document.createElement('img'); image.className = 'message-image'; image.alt = 'Attached image';
    image.src = 'data:' + block.mimeType + ';base64,' + block.data; messages.append(image);
  }
  if (message.error) addMessage('error', message.error);
}

return { addMessage, appendHistory, toolCard };
}
