import type { Attachment } from '@mini-harness/contracts/input';
import type { Conversation, ModelChoice } from '@mini-harness/contracts/conversation';
import type { MessageContent } from '@mini-harness/contracts/message';
import type { RunEvent, RunInfo } from '@mini-harness/contracts/transport';
import type { ConversationView, ThinkingLevel, ModelCatalog } from '@mini-harness/web/types';
import { scopedElements } from '@mini-harness/web/api';
import { exportSessions, isRunning } from '@mini-harness/web/transport/session-client';
import { createConversationController } from '@mini-harness/web/models/conversation-controller';
import type { Selection } from '@mini-harness/web/models/selection';
import type { RemoteStore } from '@mini-harness/web/models/remote-store';
import type { Settings } from '@mini-harness/contracts/config';
import { createMessageView } from './messages.js';
import { CommandRegistry } from './commands.js';
import type { ComposerCommand } from '@mini-harness/web/contracts/commands';
import { createComposer } from './composer.js';
import { createModelPicker } from './model-picker.js';
import type { FrontendApi, ToolView, MessageAction, DraftMode } from '@mini-harness/ui-runtime/frontend';
import { fromMarkup, required } from '@mini-harness/ui-primitives/primitives';

type Queue = ConversationView['queue'];

interface ConversationServices {
  sessions: RemoteStore<Conversation[]>;
  settings: RemoteStore<Settings>;
  models: RemoteStore<ModelCatalog>;
  closeDrawer(): void;
  showWorkspaceInHeader(show: boolean): void;
  setTitle(title: string): void;
  renderTool(tool: ToolView, action?: boolean): HTMLElement | undefined;
  messageActions(): MessageAction[];
}

export function conversationView(api: FrontendApi, state: Selection, options: ConversationServices) {
  const controller = createConversationController(api.request);
  const view = fromMarkup(`
    <div class="conversation">
      <section id="welcome" class="welcome">
        <img src="/logo.svg" width="52" height="52" alt="">
        <h1>What are we working on?</h1>
        <div id="workspaceWelcome"></div>
      </section>
      <div id="runSummary" class="run-summary" aria-label="Latest run" hidden><span></span><time></time><details id="changedFiles" hidden><summary></summary><ul></ul></details></div>
      <section id="messages" class="messages" aria-label="Messages" hidden></section>
      <div class="composer-wrap">
        <div id="approvalRequests" class="approval-requests"></div>
        <div id="queuedMessages" class="queued-messages" hidden></div>
        <div id="status" class="status" role="status"></div>
        <form id="composer" class="composer">
          <div id="attachments" class="attachments" hidden></div>
          <div id="suggestions" class="suggestions" role="listbox" aria-label="Input suggestions" hidden></div>
          <div id="draftMode" class="draft-mode" hidden><span></span><button type="button" aria-label="Cancel editing">Cancel</button></div>
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
    </div>`);
  api.slots.register('conversation.body', view);
  const { element, value } = scopedElements(view);
  const outlets = {
    composer: element('composerExtensions'), approvals: element('approvalRequests'), workspace: element('workspaceWelcome')
  };

  const messages = element('messages');
  const welcome = element('welcome');
  const summary = element('runSummary'), summaryStatus = required(summary.querySelector('span')), elapsed = required(summary.querySelector('time'));
  const states = { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed',
    cancelled: 'Cancelled', interrupted: 'Interrupted' };
  let runSummary: RunInfo | undefined;
  const changedFiles = element<'details'>('changedFiles');
  function renderChangedFiles(run?: RunInfo) {
    const paths = run?.changedFiles ?? [];
    changedFiles.hidden = paths.length === 0;
    if (!paths.length) { changedFiles.open = false; return; }
    required(changedFiles.querySelector('summary')).textContent = paths.length + (paths.length === 1 ? ' file changed' : ' files changed');
    required(changedFiles.querySelector('ul')).replaceChildren(...paths.map((path) => {
      const item = document.createElement('li');
      item.textContent = path;
      return item;
    }));
  }
  function renderElapsed() {
    if (!runSummary) return;
    const end = runSummary.finishedAt ? Date.parse(runSummary.finishedAt) : Date.now();
    const seconds = Math.max(0, Math.floor((end - Date.parse(runSummary.startedAt)) / 1000));
    elapsed.textContent = seconds < 60 ? seconds + ' s' : Math.floor(seconds / 60) + ' min ' + seconds % 60 + ' s';
  }
  function showRunSummary(run?: RunInfo) {
    runSummary = run;
    summary.hidden = !run;
    if (!run) return;
    summary.dataset.state = run.state;
    summaryStatus.textContent = states[run.state];
    renderChangedFiles(run);
    renderElapsed();
  }
  const elapsedTimer = setInterval(() => { if (isRunning(runSummary)) renderElapsed(); }, 1000);
  api.onDispose(() => clearInterval(elapsedTimer));
  const composer = element<'form'>('composer');
  const prompt = element<'textarea'>('prompt');
  const thinkingSelect = element<'select'>('thinkingLevel');

  let sending = false;
  let visit = new AbortController();
  let pending = false;
  let modelDraft: ModelChoice | undefined;
  let conversationModel: ModelChoice | undefined;
  let conversationThinking: ThinkingLevel;
  let activeLeaf: string | null | undefined;
  let draftMode: DraftMode | undefined;
  function setDraftMode(mode?: DraftMode) {
    draftMode = mode;
    const banner = element('draftMode');
    banner.hidden = !mode;
    required(banner.querySelector('span')).textContent = mode?.title ?? '';
    if (mode) {
      prompt.value = mode.text;
      adjustPrompt();
      prompt.focus();
    }
  }
  required(element('draftMode').querySelector('button')).addEventListener('click', () => setDraftMode());
  const modelPicker = createModelPicker(view, (choice) => { modelDraft = choice; updateModelControls(); }, api.signal);
  const lastInputs = new Map<string, { message: string; attachments: Attachment[] }>();
  const drafts = new Map<string, string>();
  let draftConversation: string | undefined;
  function switchDraft(id?: string) {
    if (draftConversation === id) return;
    if (draftConversation) drafts.set(draftConversation, prompt.value);
    draftConversation = id;
    prompt.value = id ? drafts.get(id) ?? '' : '';
    adjustPrompt();
  }
  const active = () => state.activeConversation;
  const begin = () => {
    visit.abort();
    visit = new AbortController();
    return visit.signal;
  };
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
  const composerUi = createComposer(view, report, commands, api.signal);
  const messageView = createMessageView(messages, {
    render: options.renderTool, messageActions: options.messageActions
  }, () => ({ sessionId: active(), leafId: activeLeaf }), () => {
    const id = active();
    const last = id ? lastInputs.get(id) : undefined;
    if (last && !sending) void send(last.message, last.attachments);
  });

  function rememberInput(id: string, content: MessageContent) {
    const attachments: Attachment[] = (typeof content === 'string' ? [] : content ?? [])
      .flatMap((block) => block.type === 'image' && block.mimeType && block.data
        ? [{ name: 'image', mimeType: block.mimeType, data: block.data }] : []);
    lastInputs.set(id, { message: messageView.textOf(content), attachments });
  }

  function showWelcome(show: boolean) {
    welcome.hidden = !show;
    messages.hidden = show;
    options.showWorkspaceInHeader(!show);
  }

  function showConversation(item?: Conversation | ConversationView, revealWorkspace = true) {
    const view = item as ConversationView;
    const history = view?.messages ?? [];
    setSending(isRunning(item?.run));
    showRunSummary(item?.run);
    showQueue(view?.queue);
    conversationModel = item?.model;
    conversationThinking = view?.thinkingLevel;
    activeLeaf = view?.leafId;
    setDraftMode();
    switchDraft(item?.id);
    if (item && !lastInputs.has(item.id)) {
      const previous = history.filter((message) => message.role === 'user').at(-1);
      if (previous) rememberInput(item.id, previous.content);
    }
    updateModelControls();
    options.setTitle(item?.title ?? 'New conversation');
    messageView.history(history, item?.run?.error);
    showWelcome(!messages.childElementCount && !isRunning(item?.run));
    state.selectConversation(item, revealWorkspace);
  }

  function display(item: ConversationView, signal: AbortSignal, revealWorkspace: boolean) {
    showConversation(item, revealWorkspace);
    if (signal.aborted) return;
    showStatus('');
    if (isRunning(item.run)) void observe(item, signal);
  }

  async function activate(id: string, revealWorkspace = true) {
    const signal = begin();
    pending = true;
    const selected = options.sessions.get().find((entry) => entry.id === id);
    if (selected && id !== active()) {
      showConversation(selected, revealWorkspace);
      showStatus('Loading conversation…');
    }
    try {
      const item = await controller.read(id, signal);
      if (signal.aborted) return;
      display(item, signal, revealWorkspace);
      options.closeDrawer();
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
    finally { if (!signal.aborted) pending = false; }
  }

  function clear(draft = false) {
    begin();
    pending = false;
    composerUi.clear();
    showConversation();
    showStatus('');
    if (draft) {
      prompt.value = '';
      adjustPrompt();
      options.closeDrawer();
      prompt.focus();
    }
  }

  function setSending(value: boolean) {
    sending = value;
    element<'button'>('send').hidden = value;
    element('queueMode').hidden = !value;
    element('queueSend').hidden = !value;
    element<'button'>('stop').hidden = !value;
    element<'button'>('stop').disabled = false;
    // Queue composer selections target the next queued turn, not the in-flight request.
  }

  async function send(text: string, attached?: Attachment[]) {
    const attachments = attached ?? composerUi.attachments();
    if (sending || pending || (!text.trim() && !attachments.length)) return;
    if (!modelPicker.selected()) {
      showStatus('Choose a configured model before sending.');
      modelPicker.open();
      return;
    }
    const choice = modelDraft;
    const thinkingLevel = thinkingSelect.value || undefined;
    const message = commands.prepare(text);
    const signal = begin();
    const workspace = state.selectedWorkspace;
    pending = true;
    setSending(true);
    try {
      let id = active();
      if (!id) {
        if (!workspace) throw new Error('Add a workspace before starting a conversation.');
        const item = await controller.create(workspace);
        await options.sessions.refresh();
        id = item.id;
        if (!signal.aborted) { showConversation(item); setSending(true); }
      }
      lastInputs.set(id, { message: text, attachments });
      if (draftMode) {
        await draftMode.submit({ text, attachments, model: choice, thinkingLevel });
      } else {
        await controller.start(id, { message, attachments, model: choice, thinkingLevel });
      }
      setDraftMode();
      if (!signal.aborted) {
        modelDraft = undefined;
        prompt.value = '';
        if (id) drafts.set(id, '');
        composerUi.clear();
        adjustPrompt();
        pending = false;
        await activate(id);
      }
    } catch (error) {
      if (!signal.aborted) { report(error instanceof Error ? error : new Error(String(error))); setSending(false); }
    } finally { if (!signal.aborted) pending = false; }
  }

  async function observe(item: ConversationView, signal: AbortSignal) {
    const render = messageView.stream(item);
    if (!item.run) return;
    showStatus(item.run.state === 'queued' ? 'Queued…' : 'Thinking…');
    function accept(event: RunEvent) {
      render(event);
      switch (event.type) {
        case 'user': if (!lastInputs.has(item.id)) rememberInput(item.id, event.content); break;
        case 'tool': showStatus(event.state === 'running' ? 'Running ' + event.name + '…' : 'Thinking…'); break;
        case 'complete':
        case 'error': showStatus(''); break;
        case 'run':
        case 'snapshot':
          showRunSummary(event.run);
          if (!isRunning(event.run)) {
            setSending(false);
            showQueue();
            showStatus('');
          }
          break;
      }
    }
    try {
      const latest = await controller.follow(item, signal, accept, () => showStatus('Reconnecting…'));
      if (latest && !signal.aborted) display(latest, signal, false);
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
  }

  function updateModelControls() {
    const catalog = options.models.get();
    const draft = modelDraft;
    if (draft && !catalog.models.some((model) => model.configured && model.provider === draft.provider && model.id === draft.id))
      modelDraft = undefined;
    const selected = modelPicker.update(catalog.models, catalog.providers,
      modelDraft ?? (sending ? conversationModel : undefined) ?? options.settings.get().model);
    const levels = selected?.thinkingLevels ?? [];
    const sameModel = selected && selected.provider === conversationModel?.provider && selected.id === conversationModel.id;
    thinkingSelect.replaceChildren(new Option('Default', ''), ...levels.map((level) =>
      new Option(level === 'xhigh' ? 'Extra high' : level[0].toUpperCase() + level.slice(1), level)));
    thinkingSelect.value = sameModel && levels.includes(conversationThinking) ? conversationThinking : '';
    thinkingSelect.hidden = levels.length < 2;
  }
  async function compactConversation() {
    const id = active();
    if (!id) throw new Error('Open a conversation to compact it.');
    if (sending || pending) throw new Error('Wait for the current operation to finish.');
    const signal = visit.signal;
    pending = true;
    showStatus('Compacting conversation…');
    try {
      await controller.compact(id);
      if (!signal.aborted) {
        const item = await controller.read(id, signal);
        if (!signal.aborted) { display(item, signal, false); showStatus('Conversation compacted.'); }
      }
    } finally { if (!signal.aborted) pending = false; }
  }
  async function queueMessage() {
    const id = active(); if (!id || !sending || pending) return;
    const signal = visit.signal;
    const button = element<'button'>('queueSend'); button.disabled = true;
    try {
      const queued = await controller.queue(id, {
        message: commands.prepare(prompt.value), mode: value('queueMode') as 'steer' | 'followUp',
        attachments: composerUi.attachments(), model: modelDraft,
        thinkingLevel: thinkingSelect.value || undefined
      });
      if (signal.aborted) return;
      prompt.value = '';
      if (id) drafts.set(id, '');
      modelDraft = undefined;
      composerUi.clear(); adjustPrompt(); updateModelControls(); showQueue(queued);
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); } finally { button.disabled = false; }
  }
  function showQueue(queue: Queue = { steer: [], followUp: [] }) {
    const items = [...queue.steer.map((text) => 'Instruction: ' + text), ...queue.followUp.map((text) => 'Follow up: ' + text)];
    element('queuedMessages').textContent = items.map((text) => text.slice(0, 180)).join('\n');
    element('queuedMessages').hidden = !items.length;
  }
  const queueTimer = setInterval(async () => {
    const id = active(), signal = visit.signal;
    if (document.hidden || !sending || !id || pending) return;
    try {
      const queue = await controller.getQueue(id, signal);
      if (!signal.aborted && sending) showQueue(queue);
    } catch { /* A completed or deleted conversation can remove the queue. */ }
  }, 1500);
  api.onDispose(() => { clearInterval(queueTimer); visit.abort(); });
  element<'button'>('stop').onclick = async () => {
    const id = active(), signal = visit.signal;
    if (!id) return;
    element<'button'>('stop').disabled = true;
    showStatus('Cancelling…');
    try { await controller.cancel(id); }
    catch (error) { if (!signal.aborted) { report(error instanceof Error ? error : new Error(String(error))); element<'button'>('stop').disabled = false; } }
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
  return {
    outlets, activate, showConversation, clear, updateModelControls, report,
    refreshTools: messageView.refreshTools,
    refreshActions: messageView.refreshActions,
    beginDraftMode(mode: DraftMode) {
      if (sending || pending || !active()) return;
      setDraftMode(mode);
    },
    cancelDraftMode: () => setDraftMode(),
    command(command: ComposerCommand) {
      const dispose = commands.register(command);
      composerUi.refresh(true);
      return () => { dispose(); composerUi.refresh(true); };
    },
    attach() {
      composerUi.attach(api);
      api.command({ name: 'model', group: 'Conversation', description: 'Choose a configured model', run: () => modelPicker.open() });
      api.command({ name: 'export', group: 'Conversation', description: 'Export the current conversation', run: () => {
        const id = active();
        if (!id) throw new Error('Open a conversation to export it.');
        return exportSessions([id], api.signal);
      } });
      api.command({ name: 'compact', group: 'Conversation', description: 'Summarize earlier messages to free context', run: compactConversation });
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
