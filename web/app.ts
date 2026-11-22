import type { Settings } from '../src/config.js';
import type { Conversation, ModelChoice } from '../src/registry.js';
import type { MessageContent, StreamEvent, RunEvent, RunInfo, ViewMessage } from '../src/protocol.js';
import type { PluginMetadata } from '../src/plugins.js';
import { renderMarkdown } from './markdown.js';

import { element, value, api, data, payload, setWorkspace } from './api.js';
import { FrontendHost } from './extensions.js';
import { createMessageView } from './messages.js';
import { hydrateIcons, icon } from './icons.js';
import { schemaFields, readPluginValues } from './settings-fields.js';

const messages = element('messages');
const welcome = element('welcome');
const composer = element<'form'>('composer');
const prompt = element<'textarea'>('prompt');
const modelSelect = element<'select'>('modelSelect');
const settingsPanel = element<'dialog'>('settingsPanel');
const settingsStatus = element('settingsStatus');
const narrow = matchMedia('(max-width: 860px)');

interface ModelInfo { provider: string; id: string; name: string; configured: boolean }
interface Bootstrap { settings: Settings; sessions: Conversation[]; models: ModelInfo[]; plugins: PluginMetadata[]; workspace: string; isolation: boolean }
interface ConversationView extends Conversation { selectedModel: ModelChoice; messages: ViewMessage[]; partial?: string; tools?: Extract<StreamEvent, { type: 'tool' }>[] }
let bootstrap: Bootstrap;
let sessions: Conversation[] = [];
let active: string | undefined;
let sending = false;
let selecting = false;
let navigation = 0;
let pendingNavigation = false;
const selection = new Set<string>();
const expanded = new Set<string>();
let observing: AbortController;
let modelChange: Promise<Settings>;
const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';

const showStatus = (text: string) => { element('status').textContent = text; };
const report = (error: Error) => showStatus(error.message);
const adjustPrompt = () => {
  prompt.style.height = 'auto';
  prompt.style.height = Math.min(prompt.scrollHeight, 210) + 'px';
};

function inspect(title: string, content: HTMLElement) {
  element('inspectorTitle').textContent = title;
  element('inspectorContent').replaceChildren(content);
  element('inspector').hidden = false;
  element('inspectorOpen').setAttribute('aria-expanded', 'true');
}
const extensions = new FrontendHost({ sidebar: element('sidebarExtensions'), composer: element('composerExtensions'),
  settings: element('settingsExtensions'), inspector: element('inspectorExtensions') }, {
  request: data, insert: (text) => { prompt.setRangeText(text, prompt.selectionStart, prompt.selectionEnd, 'end'); prompt.focus(); adjustPrompt(); }, inspect
}, report);
const { addMessage, appendHistory, toolCard } = createMessageView(messages, extensions, (id) => void activate(id), () => {
  const last = [...messages.querySelectorAll<HTMLElement>('.message.user')].at(-1);
  if (last && !sending) void send(last.innerText);
});
element('inspectorOpen').onclick = () => {
  element('inspector').hidden = !element('inspector').hidden;
  element('inspectorOpen').setAttribute('aria-expanded', String(!element('inspector').hidden));
};
element('inspectorClose').onclick = () => { element('inspector').hidden = true; element('inspectorOpen').setAttribute('aria-expanded', 'false'); };
for (const [index, section] of [...document.querySelectorAll<HTMLElement>('#settingsForm > section')].entries()) {
  section.id = 'settings-section-' + index;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'link-button';
  button.textContent = section.querySelector('h3').textContent;
  button.onclick = () => section.scrollIntoView({ block: 'start' });
  element('settingsNav').append(button);
}

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

function showConversation(item?: Conversation, history: ViewMessage[] = []) {
  observing?.abort();
  setSending(isRunning(item?.run));
  active = item?.id;
  if (bootstrap) {
    if (active) sessionStorage.setItem('mini-harness-active:' + bootstrap.workspace, active);
    else sessionStorage.removeItem('mini-harness-active:' + bootstrap.workspace);
  }
  element('conversationTitle').textContent = item?.title ?? 'New conversation';
  messages.replaceChildren();
  for (const message of history) appendHistory(message);
  if (item?.run?.error) {
    const error = [...messages.querySelectorAll<HTMLElement>('.message.error')].at(-1) ?? addMessage('error', '');
    error.textContent = item.run.error;
  }
  messages.hidden = !messages.childElementCount;
  welcome.hidden = !messages.hidden;
  messages.scrollTop = messages.scrollHeight;
  renderSessions();
}

async function activate(id: string) {
  const request = ++navigation;
  pendingNavigation = true;
  try {
    await modelChange?.catch(() => {});
    const item = await data<ConversationView>('/sessions/' + id);
    if (request !== navigation) return;
    for (let parent = item.parentId; parent && !expanded.has(parent); parent = sessions.find((entry) => entry.id === parent)?.parentId) {
      expanded.add(parent);
    }
    showConversation(item, item.messages);
    applySettings({ ...bootstrap.settings, model: item.selectedModel });
    if (isRunning(item.run)) void observe(item);
    else showStatus(item.run?.error ?? '');
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
  if (pendingNavigation) return;
  ++navigation;
  showConversation();
  prompt.value = '';
  adjustPrompt();
  showStatus('');
  closeDrawer();
  prompt.focus();
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
      if (item.run) {
        const state = document.createElement('span');
        state.className = 'run-state';
        state.dataset.state = item.run.state;
        state.textContent = item.run.state;
        state.title = item.run.error ?? item.run.state;
        row.append(state);
      }
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

async function readEvents(response: Response, accept: (event: RunEvent) => void) {
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
  const next = await data<Conversation[]>('/sessions');
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  for (const id of selection) if (!sessions.some((item) => item.id === id)) selection.delete(id);
  if (active) element('conversationTitle').textContent = sessions.find((item) => item.id === active)?.title ?? 'Conversation';
  renderSessions();
}

async function send(text: string) {
  if (sending || pendingNavigation || !text.trim()) return;
  const request = ++navigation;
  pendingNavigation = true;
  setSending(true);
  try {
    if (!active) showConversation(await createConversation());
    const id = active;
    await modelChange;
    await data<RunInfo>('/sessions/' + id + '/runs', payload('POST', { message: text }));
    prompt.value = '';
    adjustPrompt();
    if (request === navigation) {
      pendingNavigation = false;
      await activate(id);
    }
    await syncSessions();
  } catch (error) {
    if (request === navigation) { report(error); setSending(false); }
  } finally { if (request === navigation) pendingNavigation = false; }
}

async function observe(item: ConversationView) {
  const id = item.id;
  const controller = new AbortController();
  observing = controller;
  let cursor = item.run.sequence;
  let ended = false;
  const cards = new Map<string, HTMLDetailsElement>();
  let answer: HTMLElement;
  let answerText = item.partial ?? '';
  if (answerText) answer = addMessage('assistant', answerText);
  for (const tool of item.tools ?? []) cards.set(tool.id, toolCard(tool));
  setSending(true);
  welcome.hidden = true;
  messages.hidden = false;
  showStatus(item.run.state === 'queued' ? 'Queued…' : 'Thinking…');
  const accept = (event: RunEvent) => {
      if (controller.signal.aborted || active !== id) return;
      cursor = event.sequence;
      const pinned = scrollIfPinned();
      switch (event.type) {
        case 'user':
          addMessage('user', event.text);
          break;
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
        case 'assistant-end':
          if (answer) renderMarkdown(answer, answerText);
          break;
        case 'complete':
          if (event.text || answer) {
            answer ??= addMessage('assistant', '');
            renderMarkdown(answer, event.text || answerText);
          }
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
          break;
        case 'snapshot':
          messages.replaceChildren();
          cards.clear();
          for (const message of event.messages) appendHistory(message);
          answerText = event.partial ?? '';
          answer = answerText ? addMessage('assistant', answerText) : undefined;
          for (const tool of event.tools ?? []) cards.set(tool.id, toolCard(tool));
          // Fall through to apply the snapshot's run state.
        case 'run':
          ended = !isRunning(event.run);
          if (ended) showStatus(event.run.error ?? '');
          break;
      }
      if (pinned) messages.scrollTop = messages.scrollHeight;
  };
  let retries = 0;
  while (!ended && !controller.signal.aborted) {
    try {
      const response = await api('/sessions/' + id + '/events?run=' + item.run.id + '&after=' + cursor, { signal: controller.signal });
      await readEvents(response, accept);
      if (!ended && !controller.signal.aborted) throw new Error('Connection closed');
    } catch (error) {
      if (controller.signal.aborted) return;
      showStatus('Reconnecting…');
      await new Promise<void>((done) => {
        const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); done(); };
        const timer = setTimeout(finish, Math.min(5000, 500 * ++retries));
        controller.signal.addEventListener('abort', finish, { once: true });
      });
      if (controller.signal.aborted) return;
      try {
        const latest = await data<ConversationView>('/sessions/' + id, { signal: controller.signal });
        if (latest.run?.id !== item.run.id || !isRunning(latest.run)) {
          if (active === id) await activate(id);
          return;
        }
      } catch { /* Retry while this conversation remains selected. */ }
    }
  }
  if (controller.signal.aborted || active !== id) return;
  try {
    const latest = await data<ConversationView>('/sessions/' + id, { signal: controller.signal });
    if (controller.signal.aborted || active !== id) return;
    showConversation(latest, latest.messages);
    showStatus(latest.run?.error ?? '');
    await syncSessions();
    const current = await data<{ settings: Settings }>('/bootstrap');
    applySettings(current.settings);
  } catch (error) { if (!controller.signal.aborted) report(error); }
}

function selectedModel() {
  const selected = modelSelect.value;
  const slash = selected.indexOf('/');
  return slash === -1 ? { provider: '', id: '' } : { provider: selected.slice(0, slash), id: selected.slice(slash + 1) };
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
    const group = document.createElement('div');
    group.className = 'plugin-group';
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
    input.dataset.pluginSwitch = plugin.id;
    input.setAttribute('aria-label', plugin.title);
    input.checked = Boolean(settings.plugins[plugin.id]);
    label.append(description, input);
    group.append(label);
    if (plugin.requires?.length) {
      const hint = document.createElement('small');
      hint.className = 'hint';
      hint.textContent = 'Requires: ' + plugin.requires.join(', ');
      group.append(hint);
    }
    if (plugin.configSchema) {
      const fields = document.createElement('fieldset');
      fields.disabled = !input.checked;
      fields.className = 'plugin-config';
      fields.append(schemaFields(plugin.id, plugin.configSchema, settings.pluginConfig[plugin.id] ?? {}));
      input.onchange = () => { fields.disabled = !input.checked; };
      group.append(fields);
    }
    return group;
  }));
  credentialStatus();
  settingsStatus.textContent = '';
}

function credentialStatus() {
  const provider = value('provider');
  element('credentialStatus').textContent = !provider ? 'Select a provider to configure credentials.' :
    bootstrap.models.some((model) => model.provider === provider && model.configured) ? 'Credentials configured.' : 'Credentials needed.';
}

async function saveSettings() {
  const patch = {
    appearance: value('theme'),
    model: { provider: value('provider'), id: value('model') },
    plugins: Object.fromEntries([...element('pluginSettings').querySelectorAll<HTMLInputElement>('[data-plugin-switch]')].map((input) => [input.name, input.checked])),
    subagents: {
      maxDepth: element<'input'>('maxDepth').valueAsNumber, maxParallel: element<'input'>('maxParallel').valueAsNumber,
      provider: value('childProvider'), model: value('childModel')
    },
    sandbox: { mode: value('sandboxMode'), timeoutSeconds: element<'input'>('timeout').valueAsNumber }
  };
  const button = element<'button'>('saveSettings');
  button.disabled = true;
  try {
    Object.assign(patch, { pluginConfig: readPluginValues(bootstrap.settings.pluginConfig) });
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
element('selectAll').onclick = () => { for (const item of sessions) selection.add(item.id); renderSessions(); };
element('exportSessions').onclick = () => void exportSelected().catch(report);
element('deleteSessions').onclick = () => void deleteSelected().catch(report);
element<'form'>('settingsForm').onsubmit = (event) => { event.preventDefault(); void saveSettings(); };
element('saveCredential').onclick = async () => {
  try {
    const result = await data<{ models: ModelInfo[] }>('/credentials', payload('POST', { provider: value('provider'), key: value('apiKey') }));
    bootstrap.models = result.models;
    applySettings(bootstrap.settings);
    credentialStatus();
    element<'input'>('apiKey').value = '';
    settingsStatus.textContent = 'API key saved locally.';
  } catch (error) { settingsStatus.textContent = error.message; }
};
modelSelect.onchange = async () => {
  const update = data<Settings>('/settings', payload('PATCH', { model: selectedModel() }));
  modelChange = update;
  try { applySettings(await update); }
  catch (error) { applySettings(bootstrap.settings); report(error); }
  finally { if (modelChange === update) modelChange = undefined; }
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
element('provider').oninput = credentialStatus;
element('refreshModels').onclick = async () => {
  try {
    bootstrap.models = (await data<{ models: ModelInfo[] }>('/models')).models;
    applySettings(bootstrap.settings);
    credentialStatus();
    settingsStatus.textContent = 'Model status refreshed.';
  } catch (error) { settingsStatus.textContent = error.message; }
};
element('theme').onchange = async () => {
  try { applySettings(await data<Settings>('/settings', payload('PATCH', { appearance: value('theme') }))); }
  catch (error) { settingsStatus.textContent = error.message; }
};
const viewport = window.visualViewport;
const resize = () => document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
viewport?.addEventListener('resize', resize);
resize();

hydrateIcons();
setSidebar(!narrow.matches);
void data<Bootstrap>('/bootstrap').then((result) => {
  bootstrap = result;
  sessions = result.sessions;
  applySettings(result.settings);
  element('workspaceLabel').textContent = result.workspace;
  element('workspaceLabel').title = result.workspace;
  renderSessions();
  const remembered = sessionStorage.getItem('mini-harness-active:' + result.workspace);
  if (sessions.length) void activate(sessions.find((item) => item.id === remembered)?.id ?? sessions.find((item) => !item.parentId)?.id ?? sessions[0].id);
  setInterval(() => { if (!document.hidden) void syncSessions().catch(() => {}); }, 2000);
}).catch(report);
