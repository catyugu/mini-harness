import type { Settings } from '../src/config.js';
import type { Conversation, ModelChoice } from '../src/registry.js';
import type { MessageContent, StreamEvent, RunEvent, RunInfo, ViewMessage } from '../src/protocol.js';
import type { Bootstrap, ConversationView, ThinkingLevel } from './types.js';
import { renderMarkdown, markdownSource } from './markdown.js';

import { element, value, api, data, payload, setWorkspace } from './api.js';
import { FrontendHost, type FrontendApi } from './extensions.js';
import { createMessageView } from './messages.js';
import { hydrateIcons, icon } from './icons.js';
import { createSessionList } from './sessions.js';
import { CommandRegistry } from './commands.js';
import { createComposer } from './composer.js';
import { fileInspector } from './files.js';
import { providerManager } from './provider-manager.js';
import { pluginInstaller } from './plugin-manager.js';
import { workspacePicker } from './workspaces.js';
import { createModelPicker } from './model-picker.js';
import { createSettings, createSettingsNavigation } from './settings.js';

const messages = element('messages');
const welcome = element('welcome');
const composer = element<'form'>('composer');
const prompt = element<'textarea'>('prompt');
const thinkingSelect = element<'select'>('thinkingLevel');
const settingsPanel = element<'dialog'>('settingsPanel');
const narrow = matchMedia('(max-width: 860px)');

let bootstrap: Bootstrap;
let sessions: Conversation[] = [];
let active: string | undefined;
let sending = false;
let navigation = 0;
let pendingNavigation = false;
let observing: AbortController;
let modelDraft: ModelChoice;
let conversationModel: ModelChoice;
let conversationThinking: ThinkingLevel;
const modelPicker = createModelPicker((choice) => { modelDraft = choice; updateModelControls(); });
let changedFiles: string[] = [];
const lastInputs = new Map<string, { message: string; attachments: import('../src/input.js').Attachment[] }>();
const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';

const showStatus = (text: string, error = false) => {
  element('status').textContent = text;
  element('status').classList.toggle('error', error);
};
const report = (error: Error) => showStatus(error.message, true);
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
const commands = new CommandRegistry();
const settingsNavigation = createSettingsNavigation();
const extensions = new FrontendHost({ sidebar: element('sidebarExtensions'), composer: element('composerExtensions'),
  settings: element('settingsExtensions'), inspector: element('inspectorExtensions') }, {
  request: data, insert: (text) => { prompt.setRangeText(text, prompt.selectionStart, prompt.selectionEnd, 'end'); prompt.focus(); prompt.dispatchEvent(new Event('input')); }, inspect
}, report, settingsNavigation.addPage, (command) => {
  const dispose = commands.register(command);
  composerUi.refresh(true);
  return () => { dispose(); composerUi.refresh(true); };
});
const composerUi = createComposer(report, commands);
const frontendState = new Map<string, string>();
let frontendWork = Promise.resolve();
async function refreshBootstrap() {
  const latest = await data<Bootstrap>('/bootstrap');
  bootstrap = latest; sessions = latest.sessions;
  applySettings(latest.settings); fillSettings(); renderSessions();
}
function reconcileFrontend() {
  const snapshot = bootstrap;
  frontendWork = frontendWork.then(async () => {
    const desired = new Map<string, { key: string; setup?: (api: FrontendApi) => any; source?: boolean; requires?: string[] }>([
      ['core:commands', { key: 'core', setup: (api) => {
        api.command({ name: 'model', group: 'Conversation', description: 'Choose a configured model', run: () => modelPicker.open() });
        api.command({ name: 'export', group: 'Conversation', description: 'Export the current conversation', run: () => {
          if (!active) throw new Error('Open a conversation to export it.');
          return exportSessions([active]);
        } });
        api.command({ name: 'compact', group: 'Conversation', description: 'Summarize earlier messages to free context', run: compactConversation });
      } }],
      ['core:attachments', { key: 'core', setup: (api) => composerUi.attach(api) }],
      ['core:providers', { key: 'core', setup: () => providerManager(() => bootstrap.providers, refreshBootstrap) }],
      ['core:plugins', { key: 'core', setup: (api) => pluginInstaller(api, refreshBootstrap) }]
    ]);
    for (const plugin of snapshot.plugins) {
      if (!snapshot.settings.plugins[plugin.id]) continue;
      const signature = (id: string): unknown => {
        const item = snapshot.plugins.find((p) => p.id === id);
        return [snapshot.settings.pluginConfig[id] ?? {}, ...(item?.requires ?? []).map(signature)];
      };
      const key = JSON.stringify(signature(plugin.id));
      if (plugin.id === 'files') desired.set(plugin.id, { key, setup: (api) => { fileInspector(api, () => changedFiles); composerUi.references(api); } });
      else if (plugin.id === 'skills') desired.set(plugin.id, { key, setup: (api) => composerUi.skills(api) });
      else if (plugin.id === 'shell') desired.set(plugin.id, { key, setup: (api) => {
        api.tool('sandbox_shell', (tool) => {
          const result = typeof tool.content === 'string' ? tool.content : tool.content?.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
          if (!result) return;
          const pre = document.createElement('pre');
          try { const output = JSON.parse(result); pre.textContent = 'Exit ' + output.code + '\n' + (output.stdout ?? '') + (output.stderr ? '\n' + output.stderr : ''); }
          catch { pre.textContent = result; } return pre;
        });
      } });
      else if (plugin.web) desired.set(plugin.id, { key, source: true, requires: plugin.requires });
    }
    for (const id of [...frontendState.keys()].reverse()) if (!desired.has(id) || desired.get(id).key !== frontendState.get(id)) { extensions.disable(id); frontendState.delete(id); }
    const ordered: string[] = [], visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id) || !desired.has(id)) return; visited.add(id);
      for (const dependency of desired.get(id).requires ?? []) visit(dependency); ordered.push(id);
    };
    for (const id of desired.keys()) visit(id);
    for (const id of ordered) {
      const entry = desired.get(id);
      if (frontendState.get(id) === entry.key) continue;
      try {
        let setup = entry.setup;
        let config = snapshot.settings.pluginConfig[id];
        if (entry.source) {
          const sourceData = await data<{ source: string; config: Record<string, unknown> }>('/plugins/' + id + '/web');
          config = sourceData.config;
          const url = URL.createObjectURL(new Blob([sourceData.source], { type: 'text/javascript' }));
          try { setup = (await import(url)).default; } finally { URL.revokeObjectURL(url); }
          if (typeof setup !== 'function') throw new Error('Plugin UI must export a default setup function: ' + id);
        }
        await extensions.enable({ id, setup }, config);
        frontendState.set(id, entry.key);
      } catch (error) { report(error); }
    }
  }).catch(report);
}
const { addMessage, appendHistory, toolCard } = createMessageView(messages, extensions, (id) => void activate(id), () => {
  const last = lastInputs.get(active);
  if (last && !sending) void send(last.message, last.attachments);
});
element('inspectorOpen').onclick = () => {
  element('inspector').hidden = !element('inspector').hidden;
  element('inspectorOpen').setAttribute('aria-expanded', String(!element('inspector').hidden));
};
element('inspectorClose').onclick = () => { element('inspector').hidden = true; element('inspectorOpen').setAttribute('aria-expanded', 'false'); };
const { renderSessions, selection, expanded, toggleSelection } = createSessionList(() => ({ sessions, active }), (id) => void activate(id), renameSession, (item) => void deleteSession(item));

const { fillSettings } = createSettings(() => bootstrap, applySettings, refreshBootstrap, closeDrawer, async () => { await frontendWork; if (active && !sending) await activate(active); }, settingsNavigation.open);

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

function showWelcome(show: boolean) {
  welcome.hidden = !show;
  messages.hidden = show;
  const destination = show ? welcome : element('titleBlock');
  const workspace = element('workspaceOpen');
  if (workspace.parentElement !== destination) destination.append(workspace);
}

function showConversation(item?: ConversationView | Conversation, history: ViewMessage[] = []) {
  observing?.abort();
  setSending(isRunning(item?.run));
  active = item?.id;
  conversationModel = item?.model;
  conversationThinking = (item as ConversationView)?.thinkingLevel;
  changedFiles = item?.run?.changedFiles ?? [];
  const previous = history.filter((message) => message.role === 'user').at(-1);
  if (active && previous && !lastInputs.has(active)) {
    const blocks = typeof previous.content === 'string' ? [{ type: 'text', text: previous.content }] : previous.content;
    lastInputs.set(active, { message: blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
      attachments: blocks.filter((b) => b.type === 'image').map((b) => ({ name: 'image', mimeType: b.mimeType, data: b.data })) });
  }
  element('queuedMessages').hidden = true;
  if (bootstrap) {
    if (active) sessionStorage.setItem('mini-harness-active:' + bootstrap.workspace, active);
    else sessionStorage.removeItem('mini-harness-active:' + bootstrap.workspace);
  }
  updateModelControls();
  element('conversationTitle').textContent = item?.title ?? 'New conversation';
  messages.replaceChildren();
  for (const message of history) appendHistory(message);
  if (item?.run?.error) {
    const error = [...messages.querySelectorAll<HTMLElement>('.message.error')].at(-1) ?? addMessage('error', '');
    error.textContent = item.run.error;
  }
  showWelcome(!messages.childElementCount && !isRunning(item?.run));
  messages.scrollTop = messages.scrollHeight;
  renderSessions();
}

async function activate(id: string) {
  const request = ++navigation;
  pendingNavigation = true;
  try {
    const item = await data<ConversationView>('/sessions/' + id);
    if (request !== navigation) return;
    for (let parent = item.parentId; parent && !expanded.has(parent); parent = sessions.find((entry) => entry.id === parent)?.parentId) {
      expanded.add(parent);
    }
    showConversation(item, item.messages);
    applySettings({ ...bootstrap.settings, model: item.selectedModel });
    if (isRunning(item.run)) void observe(item);
    else showStatus(item.run?.error ?? '', Boolean(item.run?.error));
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
  composerUi.clear();
  adjustPrompt();
  showStatus('');
  closeDrawer();
  prompt.focus();
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
  element('queueMode').hidden = !value;
  element('queueSend').hidden = !value;
  element<'button'>('stop').hidden = !value;
  element<'button'>('stop').disabled = false;
  modelPicker.setDisabled(value);
  thinkingSelect.disabled = value;
}

async function syncSessions() {
  const next = await data<Conversation[]>('/sessions');
  if (JSON.stringify(next) === JSON.stringify(sessions)) return;
  sessions = next;
  for (const id of selection) if (!sessions.some((item) => item.id === id)) selection.delete(id);
  if (active) element('conversationTitle').textContent = sessions.find((item) => item.id === active)?.title ?? 'Conversation';
  renderSessions();
}

async function send(text: string, attached?: import('../src/input.js').Attachment[]) {
  const attachments = attached ?? composerUi.attachments();
  if (sending || pendingNavigation || (!text.trim() && !attachments.length)) return;
  const choice = modelDraft;
  const thinkingLevel = thinkingSelect.value || undefined;
  const request = ++navigation;
  pendingNavigation = true;
  setSending(true);
  try {
    if (!active) { showConversation(await createConversation()); setSending(true); }
    const id = active;
    lastInputs.set(id, { message: text, attachments });
    await data<RunInfo>('/sessions/' + id + '/runs', payload('POST', { message: commands.prepare(text), attachments, model: choice, thinkingLevel }));
    modelDraft = undefined;
    prompt.value = '';
    composerUi.clear();
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
  showWelcome(false);
  showStatus(item.run.state === 'queued' ? 'Queued…' : 'Thinking…');
  const accept = (event: RunEvent) => {
      if (controller.signal.aborted || active !== id) return;
      cursor = event.sequence;
      const pinned = scrollIfPinned();
      switch (event.type) {
        case 'user':
          lastInputs.set(id, { message: event.text, attachments: (typeof event.content === 'string' ? [] : event.content ?? []).filter((b) => b.type === 'image').map((b) => ({ name: 'image', mimeType: b.mimeType, data: b.data })) });
          appendHistory({ role: 'user', content: event.content ?? event.text, timestamp: Date.now() });
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
          markdownSource.set(answer, answerText);
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
          showStatus(event.state === 'running' ? 'Running ' + event.name + '…' : 'Thinking…');
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
          changedFiles = event.run.changedFiles ?? changedFiles;
          ended = !isRunning(event.run);
          if (ended) showStatus(event.run.error ?? '', Boolean(event.run.error));
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
    showStatus(latest.run?.error ?? '', Boolean(latest.run?.error));
    await syncSessions();
    const current = await data<{ settings: Settings }>('/bootstrap');
    applySettings(current.settings);
  } catch (error) { if (!controller.signal.aborted) report(error); }
}

function updateModelControls() {
  if (!bootstrap) return;
  if (modelDraft && !bootstrap.models.some((model) => model.configured && model.provider === modelDraft.provider && model.id === modelDraft.id))
    modelDraft = undefined;
  const selected = modelPicker.update(bootstrap.models, bootstrap.providers, modelDraft ?? bootstrap.settings.model);
  const levels = selected?.thinkingLevels ?? [];
  const sameModel = selected && selected.provider === conversationModel?.provider && selected.id === conversationModel.id;
  thinkingSelect.replaceChildren(new Option('Default', ''), ...levels.map((level) =>
    new Option(level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1), level)));
  thinkingSelect.value = sameModel && levels.includes(conversationThinking) ? conversationThinking : '';
  thinkingSelect.hidden = levels.length < 2;
}

function applySettings(settings: Settings) {
  bootstrap.settings = settings;
  reconcileFrontend();
  document.documentElement.dataset.theme = settings.appearance;
  updateModelControls();
}

async function exportSessions(ids: string[]) {
  const response = await api('/sessions/export', payload('POST', { ids }));
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'mini-harness-sessions.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

async function compactConversation() {
  const id = active;
  if (!id) throw new Error('Open a conversation to compact it.');
  if (sending || pendingNavigation) throw new Error('Wait for the current operation to finish.');
  const request = navigation;
  pendingNavigation = true;
  showStatus('Compacting conversation…');
  try {
    await data('/sessions/' + id + '/compact', payload('POST', {}));
    if (request === navigation) { await activate(id); showStatus('Conversation compacted.'); }
  } finally { if (request === navigation) pendingNavigation = false; }
}

async function deleteSelected() {
  if (!confirm('Permanently delete ' + selection.size + ' selected conversations and their descendants?')) return;
  const result = await data<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids: [...selection] }));
  if (result.deleted.includes(active)) showConversation();
  selection.clear();
  toggleSelection(false);
  await syncSessions();
}

let renaming: string;
function renameSession(item: Conversation) {
  renaming = item.id; element<'input'>('sessionTitle').value = item.title; element('renameStatus').textContent = '';
  element<'dialog'>('renamePanel').showModal(); element<'input'>('sessionTitle').select();
}
element('renameClose').onclick = () => element<'dialog'>('renamePanel').close();
element<'form'>('renameForm').onsubmit = async (event) => {
  event.preventDefault();
  try { await data('/sessions/' + renaming, payload('PATCH', { title: value('sessionTitle') })); await syncSessions(); element<'dialog'>('renamePanel').close(); }
  catch (error) { element('renameStatus').textContent = error.message; }
};
async function deleteSession(item: Conversation) {
  if (!confirm('Permanently delete "' + item.title + '" and all child conversations?')) return;
  try {
    const result = await data<{ deleted: string[] }>('/sessions/delete', payload('POST', { ids: [item.id] }));
    if (result.deleted.includes(active)) { ++navigation; showConversation(); }
    await syncSessions();
  } catch (error) { report(error); }
}
async function queueMessage() {
  const id = active; if (!id || !sending || pendingNavigation) return;
  const button = element<'button'>('queueSend'); button.disabled = true;
  try {
    const queued = await data<{ steer: string[]; followUp: string[] }>('/sessions/' + id + '/queue', payload('POST', {
      message: commands.prepare(prompt.value), mode: value('queueMode'), attachments: composerUi.attachments()
    }));
    if (active !== id) return;
    prompt.value = ''; composerUi.clear(); adjustPrompt(); showQueue(queued);
  } catch (error) { report(error); } finally { button.disabled = false; }
}
function showQueue(queue: { steer: string[]; followUp: string[] }) {
  const items = [...queue.steer.map((text) => 'Instruction: ' + text), ...queue.followUp.map((text) => 'Follow up: ' + text)];
  element('queuedMessages').textContent = items.map((text) => text.slice(0, 180)).join('\n');
  element('queuedMessages').hidden = !items.length;
}
async function refreshQueue() {
  const id = active;
  try { const queue = await data<{ steer: string[]; followUp: string[] }>('/sessions/' + id + '/queue'); if (active === id && sending) showQueue(queue); }
  catch { /* Navigation or run completion can remove the queue. */ }
}
let approvalKey = '', polling = false;
async function pollApprovals() {
  if (polling) return; polling = true;
  try {
    const approvals = await data<{ id: string; sessionId: string; command: string }[]>('/approvals');
    const key = JSON.stringify(approvals); if (key === approvalKey) return; approvalKey = key;
    element('approvalRequests').replaceChildren(...approvals.map((approval) => {
      const card = document.createElement('section'); card.className = 'approval-card';
      const title = document.createElement('strong'); title.textContent = 'Shell approval · ' + (sessions.find((s) => s.id === approval.sessionId)?.title ?? 'Conversation');
      const command = document.createElement('pre'); command.textContent = approval.command; card.append(title, command);
      for (const allow of [false, true]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'small-button'; button.textContent = allow ? 'Allow once' : 'Deny';
        button.onclick = async () => {
          try { await data('/approvals', payload('POST', { id: approval.id, allow })); card.remove(); approvalKey = ''; void pollApprovals(); }
          catch (error) { report(error); }
        }; card.append(button);
      }
      return card;
    }));
  } catch (error) { if (sending) report(error); } finally { polling = false; }
}
element('queueSend').onclick = () => void queueMessage();

element('sidebarOpen').onclick = () => setSidebar(element('sidebarOpen').getAttribute('aria-expanded') !== 'true');
element('sidebarClose').onclick = element('overlay').onclick = () => { closeDrawer(); element('sidebarOpen').focus(); };
narrow.onchange = () => setSidebar(!narrow.matches);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !settingsPanel.open) {
    if (!element('inspector').hidden) { element('inspectorClose').click(); element('inspectorOpen').focus(); }
    else closeDrawer();
  }
});
element('newSession').onclick = () => void newSession();
element('exportSessions').onclick = () => void exportSessions([...selection]).catch(report);
element('deleteSessions').onclick = () => void deleteSelected().catch(report);
element<'button'>('stop').onclick = async () => {
  if (!active) return;
  element<'button'>('stop').disabled = true;
  showStatus('Cancelling…');
  try { await api('/sessions/' + active + '/cancel', payload('POST', {})); }
  catch (error) { report(error); element<'button'>('stop').disabled = false; }
};
composer.onsubmit = (event) => { event.preventDefault(); void send(prompt.value); };
prompt.onkeydown = (event) => {
  if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (sending) void queueMessage(); else composer.requestSubmit();
  }
};
prompt.oninput = adjustPrompt;
const viewport = window.visualViewport;
const resize = () => document.documentElement.style.setProperty('--app-height', (viewport?.height ?? innerHeight) + 'px');
viewport?.addEventListener('resize', resize);
resize();

hydrateIcons();
showWelcome(true);
setSidebar(!narrow.matches);
void data<Bootstrap>('/bootstrap').then((result) => {
  bootstrap = result;
  setWorkspace(result.workspace);
  sessions = result.sessions;
  applySettings(result.settings);
  element('workspaceLabel').textContent = result.workspace;
  element('workspaceLabel').title = result.workspace;
  element('workspaceGroup').textContent = result.workspace.split(/[/\\]/).filter(Boolean).at(-1) || result.workspace;
  element('workspaceGroup').title = result.workspace;
  renderSessions();
  const remembered = sessionStorage.getItem('mini-harness-active:' + result.workspace);
  if (sessions.length) void activate(sessions.find((item) => item.id === remembered)?.id ?? sessions.find((item) => !item.parentId)?.id ?? sessions[0].id);
  workspacePicker();
  setInterval(() => { if (!document.hidden) { void syncSessions().catch(() => {}); void pollApprovals(); if (sending && active) void refreshQueue(); } }, 1500);
  void pollApprovals();
  if (!result.models.some((m) => m.configured)) {
    fillSettings(); settingsNavigation.open(true); element('settingsStatus').textContent = 'Choose a provider and model, then save an API key to start.';
  }
}).catch(report);
