import type { Settings } from '../src/config.js';
import type { Conversation } from '../src/registry.js';
import type { MessageContent, StreamEvent, ViewMessage } from '../src/protocol.js';
import { renderMarkdown } from './markdown.js';

function element<K extends keyof HTMLElementTagNameMap>(id: string): HTMLElementTagNameMap[K] {
  return document.getElementById(id) as HTMLElementTagNameMap[K];
}
const value = (id: string) => element<'input'>(id).value.trim();
const tokenFromUrl = new URLSearchParams(location.hash.slice(1)).get('token');
if (tokenFromUrl) {
  sessionStorage.setItem('mini-harness-token', tokenFromUrl);
  history.replaceState(null, '', location.pathname + location.search);
}
const token = sessionStorage.getItem('mini-harness-token');
const messages = element('messages');
const welcome = element('welcome');
const composer = element<'form'>('composer');
const prompt = element<'textarea'>('prompt');
const modelSelect = element<'select'>('modelSelect');
const settingsPanel = element<'dialog'>('settingsPanel');
const settingsStatus = element('settingsStatus');
const narrow = matchMedia('(max-width: 860px)');

interface ModelInfo { provider: string; id: string; name: string; configured: boolean }
interface PluginInfo { id: string; title: string; description: string }
interface Bootstrap { settings: Settings; sessions: Conversation[]; models: ModelInfo[]; plugins: PluginInfo[]; workspace: string; isolation: boolean }
let bootstrap: Bootstrap;
let sessions: Conversation[] = [];
let active: string | undefined;
let sending = false;
let selecting = false;
let navigation = 0;
let pendingNavigation = false;
const selection = new Set<string>();
const expanded = new Set<string>();

async function api(path: string, options: RequestInit = {}) {
  if (!token) throw new Error('Open mini-harness using the URL printed by the CLI.');
  const headers = { Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  const response = await fetch('/api' + path, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Request failed (' + response.status + ')');
  }
  return response;
}

async function data<T>(path: string, options?: RequestInit): Promise<T> {
  return (await api(path, options)).json();
}

const payload = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });
const showStatus = (text: string) => { element('status').textContent = text; };
const report = (error: Error) => showStatus(error.message);
const adjustPrompt = () => {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 210) + 'px';
};

function setSidebar(open: boolean) {
  element('sidebar').classList.toggle('open', open && narrow.matches);
  element('sidebar').inert = narrow.matches && !open;
  element('app').classList.toggle('sidebar-collapsed', !open && !narrow.matches);
  element('overlay').hidden = !(open && narrow.matches);
  element('sidebarOpen').setAttribute('aria-expanded', String(open));
}

function closeDrawer() {
  if (narrow.matches) setSidebar(false);
}

function showConversation(item?: Pick<Conversation, 'id' | 'title'>, history: ViewMessage[] = []) {
  active = item?.id;
  element('conversationTitle').textContent = item?.title ?? 'New conversation';
  messages.replaceChildren();
  for (const message of history) appendHistory(message);
  messages.hidden = !messages.childElementCount;
  welcome.hidden = !messages.hidden;
  messages.scrollTop = messages.scrollHeight;
  renderSessions();
}

async function activate(id: string) {
  if (sending) return;
  const request = ++navigation;
  pendingNavigation = true;
  try {
    const item = await data<Conversation & { messages: ViewMessage[] }>('/sessions/' + id);
    if (request !== navigation) return;
    for (let parent = item.parentId; parent && !expanded.has(parent); parent = sessions.find((entry) => entry.id === parent)?.parentId) {
      expanded.add(parent);
    }
    showConversation(item, item.messages);
    closeDrawer();
  } catch (error) { if (request === navigation) report(error); }
  finally { if (request === navigation) pendingNavigation = false; }
}

async function createConversation() {
  const item = await data<Conversation>('/sessions', payload('POST', {}));
  sessions.unshift(item);
  return item;
}

async function newSession() {
  if (sending || pendingNavigation) return;
  const request = ++navigation;
  pendingNavigation = true;
  try {
    const item = await createConversation();
    if (request !== navigation) return;
    showConversation(item);
    closeDrawer();
    prompt.focus();
  } catch (error) { report(error); }
  finally { if (request === navigation) pendingNavigation = false; }
}

function renderSessions() {
  const roots = new Map<string | null, Conversation[]>();
  for (const item of sessions) {
    if (!roots.has(item.parentId)) roots.set(item.parentId, []);
    roots.get(item.parentId).push(item);
  }

  function branch(parent: string | null) {
    const list = document.createElement('ul');
    for (const item of roots.get(parent) ?? []) {
      const entry = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'session-row' + (item.id === active ? ' active' : '');
      if (roots.has(item.id)) {
        const toggle = document.createElement('button');
        const open = expanded.has(item.id);
        toggle.type = 'button';
        toggle.className = 'tree-button';
        toggle.textContent = open ? '▾' : '▸';
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', (open ? 'Collapse ' : 'Expand ') + item.title);
        toggle.onclick = () => {
          if (open) expanded.delete(item.id);
          else expanded.add(item.id);
          renderSessions();
          document.getElementById('tree-' + item.id)?.focus();
        };
        toggle.id = 'tree-' + item.id;
        row.append(toggle);
      }
      if (selecting) {
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = 'select-' + item.id;
        checkbox.checked = selection.has(item.id);
        checkbox.setAttribute('aria-label', 'Select ' + item.title);
        checkbox.onchange = () => {
          if (checkbox.checked) selection.add(item.id);
          else selection.delete(item.id);
          updateSelection();
        };
        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.textContent = item.title;
        row.append(checkbox, label);
      } else {
        const title = document.createElement('button');
        title.type = 'button';
        title.className = 'session-name';
        title.textContent = item.title;
        title.title = item.title;
        if (item.id === active) title.setAttribute('aria-current', 'page');
        title.onclick = () => void activate(item.id);
        row.append(title);
      }
      entry.append(row);
      if (expanded.has(item.id) && roots.has(item.id)) entry.append(branch(item.id));
      list.append(entry);
    }
    return list;
  }
  element('sessions').replaceChildren(branch(null));
  updateSelection();
}

function updateSelection() {
  element('selectMode').setAttribute('aria-pressed', String(selecting));
  element('bulkActions').hidden = !selecting;
  element('selectedCount').textContent = selection.size + ' selected';
  element<'button'>('exportSessions').disabled = !selection.size;
  element<'button'>('deleteSessions').disabled = !selection.size;
}

function scrollIfPinned() {
  return messages.scrollHeight - messages.clientHeight - messages.scrollTop < 96;
}

function textOf(value?: MessageContent) {
  if (typeof value === 'string') return value;
  return value?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n') ?? '';
}

function addMessage(role: 'user' | 'assistant' | 'error', text: string) {
  const item = document.createElement('article');
  item.className = 'message ' + role;
  if (role === 'assistant') renderMarkdown(item, text);
  else item.textContent = text;
  messages.append(item);
  return item;
}

function toolCard(data: { name: string; state: string; content?: MessageContent; sessionId?: string }, card?: HTMLDetailsElement) {
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
  const output = textOf(data.content);
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
      content: message.content, sessionId: message.sessionId });
    return;
  }
  const text = textOf(message.content);
  if (text) addMessage(message.role, text);
  if (message.error) addMessage('error', message.error);
}

async function readEvents(response: Response, accept: (event: StreamEvent) => void) {
  if (!response.body) throw new Error('No response stream');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) if (line) accept(JSON.parse(line));
    }
    if (buffer.trim()) accept(JSON.parse(buffer));
  } finally { await reader.cancel().catch(() => {}); }
}

function setSending(value: boolean) {
  sending = value;
  element<'button'>('send').hidden = value;
  element<'button'>('stop').hidden = !value;
  element<'button'>('stop').disabled = false;
  modelSelect.disabled = value;
}

async function syncSessions() {
  sessions = await data<Conversation[]>('/sessions');
  if (active) element('conversationTitle').textContent = sessions.find((item) => item.id === active)?.title ?? 'Conversation';
  renderSessions();
}

async function send(text: string) {
  if (sending || pendingNavigation || !text.trim()) return;
  setSending(true);
  prompt.value = '';
  adjustPrompt();
  try {
    if (!active) showConversation(await createConversation());
    welcome.hidden = true;
    messages.hidden = false;
    addMessage('user', text);
    messages.scrollTop = messages.scrollHeight;
    showStatus('Thinking…');
    const cards = new Map<string, HTMLDetailsElement>();
    let answer: HTMLElement;
    let answerText = '';
    let ended = false;
    const accept = (event: StreamEvent) => {
      const pinned = scrollIfPinned();
      switch (event.type) {
        case 'assistant-start':
          if (answer) renderMarkdown(answer, answerText);
          answer = undefined;
          answerText = '';
          break;
        case 'delta':
          answer ??= addMessage('assistant', '');
          answerText += event.text;
          // Plain text during streaming keeps selection stable. Format at turn boundaries.
          answer.textContent = answerText;
          break;
        case 'complete':
          if (event.text || answer) {
            answer ??= addMessage('assistant', '');
            renderMarkdown(answer, event.text || answerText);
          }
          ended = true;
          showStatus('');
          break;
        case 'tool':
          if (answer) renderMarkdown(answer, answerText);
          cards.set(event.id, toolCard(event, cards.get(event.id)));
          showStatus(event.state === 'running' ? 'Using ' + event.name + '…' : 'Thinking…');
          break;
        case 'error':
          if (answer) renderMarkdown(answer, answerText);
          addMessage('error', event.error);
          showStatus('');
          ended = true;
          break;
      }
      if (pinned) messages.scrollTop = messages.scrollHeight;
    };
    const response = await api('/sessions/' + active + '/messages', payload('POST', { message: text }));
    await readEvents(response, accept);
    if (!ended) throw new Error('The response stream closed before the run finished.');
    await syncSessions();
  } catch (error) { report(error); }
  finally { setSending(false); prompt.focus(); }
}

function applySettings(settings: Settings) {
  bootstrap.settings = settings;
  document.documentElement.dataset.theme = settings.appearance;
  modelSelect.replaceChildren(new Option('Auto model', ''));
  for (const model of bootstrap.models) {
    modelSelect.append(new Option(model.name + ' · ' + model.provider, model.provider + '/' + model.id));
  }
  const selected = settings.model;
  const modelKey = selected.provider + '/' + selected.id;
  if (selected.provider && ![...modelSelect.options].some((option) => option.value === modelKey)) {
    modelSelect.add(new Option(selected.id || selected.provider + ' · Auto', modelKey));
  }
  modelSelect.value = selected.provider ? modelKey : '';
}

function fillSettings() {
  const { settings, plugins, isolation } = bootstrap;
  element<'select'>('theme').value = settings.appearance;
  element<'input'>('provider').value = settings.model.provider;
  element<'input'>('model').value = settings.model.id;
  element<'input'>('maxDepth').valueAsNumber = settings.subagents.maxDepth;
  element<'input'>('maxParallel').valueAsNumber = settings.subagents.maxParallel;
  element<'input'>('childProvider').value = settings.subagents.provider;
  element<'input'>('childModel').value = settings.subagents.model;
  element<'select'>('sandboxMode').value = settings.sandbox.mode;
  element<'input'>('timeout').valueAsNumber = settings.sandbox.timeoutSeconds;
  element('isolationStatus').textContent = isolation
    ? 'File tools are workspace-scoped. Linux shell isolation is available. Trusted host mode uses your user permissions.'
    : 'File tools are workspace-scoped. Shell isolation is unavailable on this host. Trusted host mode uses your user permissions.';
  element('pluginSettings').replaceChildren(...plugins.map((plugin) => {
    const label = document.createElement('label');
    label.className = 'switch-line';
    const description = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = plugin.title;
    const hint = document.createElement('small');
    hint.textContent = plugin.description;
    description.append(title, hint);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = plugin.id;
    input.setAttribute('aria-label', plugin.title);
    input.checked = Boolean(settings.plugins[plugin.id]);
    label.append(description, input);
    return label;
  }));
  settingsStatus.textContent = '';
}

async function saveSettings() {
  const patch = {
    appearance: value('theme'),
    model: { provider: value('provider'), id: value('model') },
    plugins: Object.fromEntries([...element('pluginSettings').querySelectorAll('input')].map((input) => [input.name, input.checked])),
    subagents: {
      maxDepth: element<'input'>('maxDepth').valueAsNumber, maxParallel: element<'input'>('maxParallel').valueAsNumber,
      provider: value('childProvider'), model: value('childModel')
    },
    sandbox: { mode: value('sandboxMode'), timeoutSeconds: element<'input'>('timeout').valueAsNumber }
  };
  const button = element<'button'>('saveSettings');
  button.disabled = true;
  try {
    applySettings(await data<Settings>('/settings', payload('PATCH', patch)));
    settingsStatus.textContent = 'Saved.';
  } catch (error) { settingsStatus.textContent = error.message; }
  finally { button.disabled = false; }
}

async function exportSelected() {
  const response = await api('/sessions/export', payload('POST', { ids: [...selection] }));
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'mini-harness-sessions.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function deleteSelected() {
  if (!confirm('Permanently delete ' + selection.size + ' selected conversations and their descendants?')) return;
  const result = await data<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids: [...selection] }));
  if (result.deleted.includes(active)) showConversation();
  selection.clear();
  selecting = false;
  await syncSessions();
}

function toggleSelection(value: boolean) {
  selecting = value;
  selection.clear();
  renderSessions();
}

element('sidebarOpen').onclick = () => setSidebar(element('sidebarOpen').getAttribute('aria-expanded') !== 'true');
element('sidebarClose').onclick = element('overlay').onclick = () => { closeDrawer(); element('sidebarOpen').focus(); };
narrow.onchange = () => setSidebar(!narrow.matches);
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !settingsPanel.open) closeDrawer(); });
element('settingsOpen').onclick = () => {
  if (!bootstrap) return;
  fillSettings();
  closeDrawer();
  settingsPanel.showModal();
};
element('settingsClose').onclick = () => settingsPanel.close();
element('newSession').onclick = () => void newSession();
element('selectMode').onclick = () => toggleSelection(!selecting);
element('cancelSelection').onclick = () => toggleSelection(false);
element('exportSessions').onclick = () => void exportSelected().catch(report);
element('deleteSessions').onclick = () => void deleteSelected().catch(report);
element<'form'>('settingsForm').onsubmit = (event) => { event.preventDefault(); void saveSettings(); };
element('saveCredential').onclick = async () => {
  try {
    await api('/credentials', payload('POST', { provider: value('provider'), key: value('apiKey') }));
    element<'input'>('apiKey').value = '';
    settingsStatus.textContent = 'API key saved locally.';
  } catch (error) { settingsStatus.textContent = error.message; }
};
modelSelect.onchange = async () => {
  const selected = modelSelect.value;
  const slash = selected.indexOf('/');
  const model = slash === -1 ? { provider: '', id: '' } : { provider: selected.slice(0, slash), id: selected.slice(slash + 1) };
  try { applySettings(await data<Settings>('/settings', payload('PATCH', { model }))); }
  catch (error) { applySettings(bootstrap.settings); report(error); }
};
element<'button'>('stop').onclick = async () => {
  if (!active) return;
  element<'button'>('stop').disabled = true;
  showStatus('Cancelling…');
  try { await api('/sessions/' + active + '/cancel', payload('POST', {})); }
  catch (error) { report(error); element<'button'>('stop').disabled = false; }
};
composer.onsubmit = (event) => { event.preventDefault(); void send(prompt.value); };
prompt.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    composer.requestSubmit();
  }
};
prompt.oninput = adjustPrompt;

setSidebar(!narrow.matches);
void data<Bootstrap>('/bootstrap').then((result) => {
  bootstrap = result;
  sessions = result.sessions;
  applySettings(result.settings);
  element('workspaceLabel').textContent = result.workspace;
  element('workspaceLabel').title = result.workspace;
  renderSessions();
  if (sessions.length) void activate(sessions.find((item) => !item.parentId)?.id ?? sessions[0].id);
}).catch(report);
