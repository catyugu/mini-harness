import type { Settings } from '../src/config.js';
import type { Conversation, ModelChoice } from '../src/registry.js';
import type { RunEvent, RunInfo, ViewMessage } from '../src/protocol.js';
import type { Bootstrap, ConversationView, ThinkingLevel } from './types.js';
import { renderMarkdown, markdownSource } from './markdown.js';
import { element, value, api as request, data, payload } from './api.js';
import { createMessageView } from './messages.js';
import { CommandRegistry, type ComposerCommand } from './commands.js';
import { createComposer } from './composer.js';
import { createModelPicker } from './model-picker.js';
import type { FrontendApi, FrontendHost } from './extensions.js';
import { fromMarkup } from './primitives.js';

interface ConversationServices {
  bootstrap(): Bootstrap;
  applySettings(settings: Settings): void;
  renderSessions(): void;
  syncSessions(): Promise<void>;
  reveal(id: string | null): void;
  addSession(item: Conversation): void;
  exportSessions(ids: string[]): Promise<void>;
  closeDrawer(): void;
  placeWorkspace(parent: HTMLElement): void;
  renderTool: FrontendHost['render'];
}

export function conversationView(api: FrontendApi, options: ConversationServices) {
  api.mount('conversation', fromMarkup(`
    <div class="conversation">
      <section id="welcome" class="welcome">
        <img src="/logo.svg" width="52" height="52" alt="">
        <h1>What are we working on?</h1>
      </section>
      <section id="messages" class="messages" aria-label="Messages" hidden></section>
      <div class="composer-wrap">
        <div id="approvalRequests" class="approval-requests"></div>
        <div id="queuedMessages" class="queued-messages" hidden></div>
        <div id="status" class="status" role="status"></div>
        <form id="composer" class="composer">
          <div id="attachments" class="attachments" hidden></div>
          <div id="suggestions" class="suggestions" role="listbox" aria-label="Input suggestions" hidden></div>
          <textarea id="prompt" rows="2" placeholder="Ask anything…" aria-label="Message" aria-controls="suggestions" aria-autocomplete="list" required></textarea>
          <div class="composer-footer">
            <div id="composerExtensions" class="composer-tools"></div><button id="modelSelect" class="model-select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelResults">Choose model</button>
            <div id="modelPicker" class="model-picker" popover="auto">
              <input id="modelSearch" type="search" role="combobox" aria-label="Search models" aria-controls="modelResults" aria-autocomplete="list" aria-expanded="true" placeholder="Search models">
              <div id="modelResults" role="listbox" aria-label="Configured models"></div>
              <p id="modelEmpty" class="hint" role="status" hidden></p>
            </div>
            <select id="thinkingLevel" aria-label="Thinking level" hidden></select>
            <select id="queueMode" aria-label="While running" hidden><option value="steer">Add instruction</option><option value="followUp">Follow up</option></select>
            <button id="queueSend" class="small-button" type="button" hidden>Queue</button>
            <button id="stop" type="button" aria-label="Stop response" hidden data-icon="stop"></button>
            <button id="send" type="submit" aria-label="Send" data-icon="send"></button>
          </div>
        </form>
      </div>
    </div>`));

  const messages = element('messages');
  const welcome = element('welcome');
  const composer = element<'form'>('composer');
  const prompt = element<'textarea'>('prompt');
  const thinkingSelect = element<'select'>('thinkingLevel');

  let active: string | undefined;
  let sending = false;
  let navigation = 0;
  let pendingNavigation = false;
  let observing: AbortController;
  let modelDraft: ModelChoice;
  let conversationModel: ModelChoice;
  let conversationThinking: ThinkingLevel;
  const modelPicker = createModelPicker((choice) => { modelDraft = choice; updateModelControls(); }, api.signal);
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
  const commands = new CommandRegistry();
  const composerUi = createComposer(report, commands, api.signal);
  const { addMessage, appendHistory, toolCard } = createMessageView(messages, { render: options.renderTool }, () => {
    const last = lastInputs.get(active);
    if (last && !sending) void send(last.message, last.attachments);
  });

  function showWelcome(show: boolean) {
    welcome.hidden = !show;
    messages.hidden = show;
    options.placeWorkspace(show ? welcome : element('titleBlock'));
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
    if (options.bootstrap()) {
      if (active) sessionStorage.setItem('mini-harness-active:' + options.bootstrap().workspace, active);
      else sessionStorage.removeItem('mini-harness-active:' + options.bootstrap().workspace);
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
    options.renderSessions();
  }

  async function activate(id: string) {
    const request = ++navigation;
    pendingNavigation = true;
    try {
      const item = await data<ConversationView>('/sessions/' + id);
      if (request !== navigation) return;
      options.reveal(item.parentId);
      showConversation(item, item.messages);
      options.applySettings({ ...options.bootstrap().settings, model: item.selectedModel });
      if (isRunning(item.run)) void observe(item);
      else showStatus(item.run?.error ?? '', Boolean(item.run?.error));
      options.closeDrawer();
    } catch (error) { if (request === navigation) report(error); }
    finally { if (request === navigation) pendingNavigation = false; }
  }

  async function createConversation() {
    const item = await data<Conversation>('/sessions', payload('POST', {}));
    options.addSession(item);
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
    options.closeDrawer();
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
      await options.syncSessions();
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
        const response = await request('/sessions/' + id + '/events?run=' + item.run.id + '&after=' + cursor, { signal: controller.signal });
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
      await options.syncSessions();
      const current = await data<{ settings: Settings }>('/bootstrap');
      options.applySettings(current.settings);
    } catch (error) { if (!controller.signal.aborted) report(error); }
  }

  function updateModelControls() {
    const bootstrap = options.bootstrap();
    if (!bootstrap) return;
    if (modelDraft && !bootstrap.models.some((model) => model.configured && model.provider === modelDraft.provider && model.id === modelDraft.id))
      modelDraft = undefined;
    const selected = modelPicker.update(bootstrap.models, bootstrap.providers, modelDraft ?? options.bootstrap().settings.model);
    const levels = selected?.thinkingLevels ?? [];
    const sameModel = selected && selected.provider === conversationModel?.provider && selected.id === conversationModel.id;
    thinkingSelect.replaceChildren(new Option('Default', ''), ...levels.map((level) =>
      new Option(level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1), level)));
    thinkingSelect.value = sameModel && levels.includes(conversationThinking) ? conversationThinking : '';
    thinkingSelect.hidden = levels.length < 2;
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
  element<'button'>('stop').onclick = async () => {
    if (!active) return;
    element<'button'>('stop').disabled = true;
    showStatus('Cancelling…');
    try { await request('/sessions/' + active + '/cancel', payload('POST', {})); }
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

  element('queueSend').onclick = () => void queueMessage();
  composerUi.attach(api);
  api.onDispose(() => observing?.abort());
  return {
    newSession, activate, showConversation, updateModelControls,
    clear() { ++navigation; pendingNavigation = false; showConversation(); },
    active: () => active, changedFiles: () => changedFiles, sending: () => sending,
    refreshQueue, report,
    command(command: ComposerCommand) {
      const dispose = commands.register(command);
      composerUi.refresh(true);
      return () => { dispose(); composerUi.refresh(true); };
    },
    registerCoreCommands(register: (command: ComposerCommand) => void) {
      register({ name: 'model', group: 'Conversation', description: 'Choose a configured model', run: () => modelPicker.open() });
      register({ name: 'export', group: 'Conversation', description: 'Export the current conversation', run: () => {
        if (!active) throw new Error('Open a conversation to export it.');
        return options.exportSessions([active]);
      } });
      register({ name: 'compact', group: 'Conversation', description: 'Summarize earlier messages to free context', run: compactConversation });
    },
    completion: composerUi.completion,
    insert(text: string) {
      const at = prompt.selectionStart;
      if (text.startsWith('/') && at && /\S$/.test(prompt.value.slice(0, at))) text = ' ' + text;
      prompt.setRangeText(text, at, prompt.selectionEnd, 'end');
      prompt.focus();
      prompt.dispatchEvent(new Event('input'));
    }
  };
}
