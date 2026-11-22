import type { MessageContent, ViewMessage } from '../src/protocol.js';
import type { FrontendHost } from './extensions.js';
import { projectTurns, textContent } from './session-projection.js';
import { toolPresentation } from './tool-presentation.js';
import { icon } from './icons.js';
import { renderMarkdown, markdownSource } from './markdown.js';

export function createMessageView(messages: HTMLElement, extensions: Pick<FrontendHost, 'render' | 'chat'>, retryLast: () => void, inspect: (id: string) => void = () => {}, openResource: (path: string, diff?: boolean) => void = () => {}) {

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
  copy.onclick = async () => { try { await navigator.clipboard.writeText(markdownSource.get(item) ?? item.textContent); copy.textContent = 'Copied'; } catch { copy.textContent = 'Copy failed'; } };
  actions.append(copy);
  if (role === 'error') {
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'link-button'; retry.textContent = 'Retry';
    retry.onclick = () => retryLast(); actions.append(retry);
  }
  wrapper.append(actions); messages.append(wrapper);
  return item;
}

function toolCard(data: { name: string; state: string; content?: MessageContent; arguments?: unknown; sessionId?: string; id?: string; elapsedMs?: number; details?: unknown }, card?: HTMLDetailsElement) {
  const item = card ?? document.createElement('details');
  item.className = 'tool-card';
  item.dataset.state = data.state;
  const summary = document.createElement('summary');
  const model = toolPresentation(data);
  item.dataset.kind = model.kind;
  const name = document.createElement('strong');
  name.className = 'tool-description';
  name.textContent = model.title + (model.summary ? ' · ' + model.summary : '');
  name.title = data.name;
  const status = document.createElement('span');
  status.className = 'tool-state';
  status.textContent = data.state === 'finished' ? 'Done' : data.state === 'running' ? 'Running' : 'Failed';
  item.dataset.renderedState = data.state;
  summary.append(icon('chevron'), icon(model.icon), name);
  if (model.exitCode !== undefined) status.textContent = 'Exit ' + model.exitCode;
  summary.append(status);
  if (model.diff) {
    summary.classList.add('diff-summary');
    const counts = document.createElement('small'); counts.className = 'diff-change-count'; counts.textContent = '+' + model.added + ' −' + model.removed; summary.append(counts);
    const peek = document.createElement('pre'); peek.className = 'diff-peek';
    peek.textContent = model.diff.split('\n').slice(0, 9).join('\n');
    summary.append(peek);
  }
  const body = document.createElement('div');
  body.className = 'tool-content';
  const custom = extensions.render(data);
  if (model.path) {
    const path = document.createElement('button'); path.type = 'button'; path.className = 'link-button tool-path';
    path.textContent = model.path; path.onclick = () => openResource(model.path, model.kind === 'diff'); body.append(path);
  }
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
    result.className = model.kind === 'terminal' ? 'terminal-output' : model.kind === 'diff' ? 'diff' : '';
    result.textContent = model.diff ?? model.terminalText ?? output;
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
  if (data.id) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'link-button inspect-tool';
    button.textContent = 'Inspect'; button.onclick = () => inspect(data.id); body.append(button);
  }
  item.replaceChildren(summary, body);
  if (!card) messages.append(item);
  return item;
}

function appendHistory(message: ViewMessage) {
  const custom = extensions.chat(message);
  if (custom) { messages.append(custom); return; }
  if (message.role === 'toolResult') {
    toolCard({ name: message.toolName ?? 'Tool', state: message.isError ? 'error' : 'finished',
      id: message.toolCallId, details: message.details, elapsedMs: message.elapsedMs, content: message.content, arguments: message.arguments, sessionId: message.sessionId });
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

function renderHistory(history: ViewMessage[], runs: import('../src/protocol.js').RunInfo[] = [], mode = 'standard', collapse = 'completed') {
  messages.replaceChildren();
  const turns = projectTurns(history, runs);
  const completed = document.createDocumentFragment();
  for (const [index, turn] of turns.entries()) {
    const section = document.createElement('article');
    section.className = 'conversation-turn';
    section.dataset.turn = turn.id;
    section.dataset.state = turn.state;
    appendHistory(turn.user);
    while (messages.firstChild) section.append(messages.firstChild);
    if (turn.process.length) {
      const process = document.createElement('details');
      process.className = 'process-group';
      const label = document.createElement('summary');
      const tools = turn.process.filter(({ role }) => role === 'toolResult').length;
      label.textContent = tools ? tools + ' tool operation' + (tools === 1 ? '' : 's') : 'Execution process';
      process.append(label);
      const failed = turn.process.some((message) => message.isError || message.error);
      if (failed) label.textContent += ' · Failed';
      process.open = failed || mode === 'detailed' || collapse === 'never' ||
        (collapse === 'next-turn' && index === turns.length - 1) || turn.state !== 'completed';
      for (const message of turn.process) appendHistory(message);
      while (messages.firstChild) process.append(messages.firstChild);
      section.append(process);
    }
    if (turn.final) {
      appendHistory(turn.final);
      while (messages.firstChild) section.append(messages.firstChild);
      if (index === turns.length - 1) section.classList.add('latest-reply');
    }
    // Append after collecting the temporary message nodes above.
    completed.append(section);
  }
  messages.append(completed);
}
return { addMessage, appendHistory, toolCard, renderHistory };
}
