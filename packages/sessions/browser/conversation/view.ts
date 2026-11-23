import type { BrowserProjectionPort } from '@mini-harness/contracts/browser';
import type { Attachment } from '@mini-harness/contracts/input';
import type { Conversation, ConversationPermission, ModelChoice } from '@mini-harness/contracts/conversation';
import type { MessageContent } from '@mini-harness/contracts/message';
import type { RunEvent } from '@mini-harness/contracts/transport';
import type { ConversationView, ThinkingLevel, ModelCatalog } from '@mini-harness/web/types';
import { scopedElements } from '@mini-harness/web/api';
import { exportSessions, isRunning } from '@mini-harness/web/transport/session-client';
import { createConversationController } from '@mini-harness/web/models/conversation-controller';
import type { Selection } from '@mini-harness/web/models/selection';
import type { RemoteStore } from '@mini-harness/web/models/remote-store';
import { createMessageView } from './messages.js';
import { CommandRegistry } from './commands.js';
import type { ComposerCommand } from '@mini-harness/web/contracts/commands';
import { createComposer, type ConversationDraft } from './composer.js';
import { createModelPicker } from './model-picker.js';
import { createThinkingPicker } from './thinking-picker.js';
import type { FrontendApi, ToolView, MessageAction, DraftMode } from '@mini-harness/ui-runtime/frontend';
import { fromMarkup, required } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import { createRunSummary } from './run-summary.js';
import { renderQueue } from './queue-view.js';

type Queue = ConversationView['queue'];

interface ConversationServices {
  sessions: RemoteStore<Conversation[]>;
  projections: BrowserProjectionPort;
  models: { get(): ModelCatalog & { recent: ModelChoice } };
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
            <div id="composerExtensions" class="composer-tools"></div>
            <button id="permissionSelect" class="permission-select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="permissionResults"></button>
            <div id="permissionPicker" class="model-picker permission-picker" popover="auto">
              <div id="permissionResults" role="listbox" aria-label="Conversation permissions"></div>
            </div>
            <button id="modelSelect" class="model-select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="modelResults">Choose model</button>
            <div id="modelPicker" class="model-picker" popover="auto">
              <input id="modelSearch" type="search" role="combobox" aria-label="Search models" aria-controls="modelResults" aria-autocomplete="list" aria-expanded="true" placeholder="Search models">
              <div id="modelResults" role="listbox" aria-label="Configured models"></div>
              <p id="modelEmpty" class="hint" role="status" hidden></p>
            </div>
            <button id="thinkingLevel" class="model-select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="thinkingResults" hidden>Default</button>
            <div id="thinkingPicker" class="model-picker thinking-picker" popover="auto"><div id="thinkingResults" role="listbox" aria-label="Thinking levels"></div></div>
            <button id="queueSend" class="small-button" type="button" hidden>Queue</button>
            <button id="stop" type="button" aria-label="Stop response" hidden data-icon="stop"></button>
            <button id="send" type="submit" aria-label="Send" data-icon="send"></button>
          </div>
        </form>
      </div>
    </div>`);
  api.slots.register('conversation.body', view);
  const { element } = scopedElements(view);
  const outlets = {
    composer: element('composerExtensions'), approvals: element('approvalRequests'), workspace: element('workspaceWelcome')
  };

  const messages = element('messages');
  const welcome = element('welcome');
  const showRunSummary = createRunSummary(element('runSummary'), api.onDispose);
  const composer = element<'form'>('composer');
  const prompt = element<'textarea'>('prompt');

  let sending = false;
  let conversationPermission: ConversationPermission = 'standard';
  const permissionButton = element<'button'>('permissionSelect');
  const permissionPopup = element('permissionPicker');
  const permissionResults = element('permissionResults');
  const permissionLabels: Record<ConversationPermission, string> = {
    standard: 'Standard', readOnly: 'Read-only', fullAccess: 'Full access'
  };
  const permissionOptions: Array<{ value: ConversationPermission; description: string }> = [
    { value: 'fullAccess', description: 'Run enabled tools without approval prompts, including Shell' },
    { value: 'standard', description: 'Ask before Shell commands; follow existing tool policies' },
    { value: 'readOnly', description: 'Only read files, search and load skills; no edits or Shell' }
  ];
  function renderPermission() {
    const current = conversationPermission;
    const label = permissionLabels[current];
    permissionButton.replaceChildren(icon(current === 'readOnly' ? 'lock' : current === 'fullAccess' ? 'unlock' : 'shield'), document.createTextNode(label), icon('chevron'));
    permissionButton.setAttribute('aria-label', 'Permissions: ' + label);
    permissionButton.title = 'Conversation permissions: ' + label;
    permissionResults.replaceChildren(...permissionOptions.map(({ value, description }) => {
      const option = document.createElement('button');
      option.type = 'button';
      option.className = 'permission-option';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(value === current));
      const name = document.createElement('strong');
      name.textContent = permissionLabels[value];
      const details = document.createElement('small');
      details.textContent = description;
      option.append(name, details);
      option.onclick = async () => {
        permissionPopup.hidePopover();
        permissionButton.focus();
        if (value === conversationPermission) return;
        const id = active();
        if (!id) {
          draftEntry.permission = value;
          conversationPermission = value;
          renderPermission();
          return;
        }
        permissionButton.disabled = true;
        try {
          const updated = await controller.setPermission(id, value);
          if (active() !== id) return;
          conversationPermission = updated.permission ?? 'standard';
          renderPermission();
          await options.sessions.refresh();
        } catch (error) {
          if (active() === id) report(error instanceof Error ? error : new Error(String(error)));
        } finally { permissionButton.disabled = false; }
      };
      return option;
    }));
  }
  permissionButton.onclick = () => {
    if (permissionPopup.matches(':popover-open')) permissionPopup.hidePopover();
    else {
      permissionPopup.showPopover();
      const bounds = permissionButton.getBoundingClientRect();
      const width = Math.min(290, innerWidth - 16);
      permissionPopup.style.width = width + 'px';
      permissionPopup.style.left = Math.max(8, Math.min(bounds.left, innerWidth - width - 8)) + 'px';
      permissionPopup.style.top = Math.max(8, bounds.top - permissionPopup.offsetHeight - 6) + 'px';
      permissionResults.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    }
  };
  permissionPopup.addEventListener('toggle', () => permissionButton.setAttribute('aria-expanded', String(permissionPopup.matches(':popover-open'))), { signal: api.signal });
  renderPermission();
  let visit = new AbortController();
  let pending = false;
  let queueRevision = 0;
  let modelDraft: ModelChoice | undefined;
  let conversationModel: ModelChoice | undefined;
  let conversationThinking: ThinkingLevel | undefined;
  let thinkingDraft: ThinkingLevel | null | undefined;
  const thinkingPicker = createThinkingPicker(view, (level) => { thinkingDraft = level; updateModelControls(); }, api.signal);
  let activeLeaf: string | null | undefined;
  const modelPicker = createModelPicker(view, (choice) => { modelDraft = choice; thinkingDraft = undefined; updateModelControls(); }, api.signal);
  const submitted = new Map<string, { runId: string; clear: () => void }>();
  const lastInputs = new Map<string, { message: string; attachments: Attachment[] }>();
  const blankDraft = (): ConversationDraft => ({ text: '', attachments: [], version: 0, loading: 0 });
  const drafts = new Map<string, { input: ConversationDraft; edit?: ConversationDraft; permission?: ConversationPermission }>();
  const ensureDraft = (key: string) => {
    let entry = drafts.get(key);
    if (!entry) { entry = { input: blankDraft() }; drafts.set(key, entry); }
    return entry;
  };
  let draftEntry = ensureDraft('workspace:' + state.selectedWorkspace);
  const draft = () => draftEntry.edit ?? draftEntry.input;
  function renderDraft() {
    const current = draft();
    const banner = element('draftMode');
    banner.hidden = !current.revision;
    required(banner.querySelector('span')).textContent = current.revision?.title ?? '';
    prompt.value = current.text;
    adjustPrompt();
    composerUi.resetSuggestions();
    composerUi.render();
  }
  function switchDraft(id?: string) {
    const next = ensureDraft(id ?? 'workspace:' + state.selectedWorkspace);
    if (draftEntry === next) return;
    draftEntry = next;
    renderDraft();
  }
  function cancelDraftMode() {
    for (const entry of drafts.values()) delete entry.edit;
    renderDraft();
  }
  required(element('draftMode').querySelector('button')).addEventListener('click', () => {
    delete draftEntry.edit;
    renderDraft();
  });
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
  const composerUi = createComposer(view, draft, report, commands, api.signal);
  const messageView = createMessageView(api, messages, {
    render: options.renderTool, messageActions: options.messageActions
  }, () => ({ sessionId: active(), leafId: activeLeaf }), () => {
    const id = active();
    const last = id ? lastInputs.get(id) : undefined;
    if (!last || sending) return;
    const current = draft();
    if (current.text === last.message && (current.revision || JSON.stringify(current.attachments) === JSON.stringify(last.attachments)))
      void send(current.text);
    else void send(last.message, last.attachments);
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
    if (item && view?.messages) {
      const submission = submitted.get(item.id);
      if (submission && history.some(({ submissionId }) => submissionId === submission.runId)) {
        submission.clear();
        submitted.delete(item.id);
      } else if (submission && !isRunning(item.run)) submitted.delete(item.id);
    }
    setSending(isRunning(item?.run));
    showRunSummary(item?.run);
    showQueue(view?.queue);
    conversationModel = item?.model;
    conversationThinking = view?.thinkingLevel;
    activeLeaf = view?.leafId;
    const switched = item?.id !== active();
    switchDraft(item?.id);
    conversationPermission = item?.permission ?? (item ? 'standard' : draftEntry.permission ?? 'standard');
    renderPermission();
    if (item && !lastInputs.has(item.id)) {
      const previous = history.filter((message) => message.role === 'user').at(-1);
      if (previous) rememberInput(item.id, previous.content);
    }
    updateModelControls();
    options.setTitle(item?.title ?? 'New conversation');
    state.selectConversation(item, revealWorkspace);
    messageView.history(history, item?.run?.state === 'failed' ? item.run.error : undefined, switched);
    showWelcome(!messages.childElementCount && !isRunning(item?.run));
  }

  function display(item: ConversationView, signal: AbortSignal, revealWorkspace: boolean) {
    showConversation(item, revealWorkspace);
    if (signal.aborted) return;
    showStatus(item.logError ?? '', Boolean(item.logError));
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
    showConversation();
    showStatus('');
    if (draft) {
      options.closeDrawer();
      prompt.focus();
    }
  }

  function setSending(value: boolean) {
    sending = value;
    element<'button'>('send').hidden = value;
    element('queueSend').hidden = !value;
    element<'button'>('stop').hidden = !value;
    element<'button'>('stop').disabled = false;
    // Queue composer selections target the next queued turn, not the in-flight request.
  }

  function snapshotDraft(attached?: Attachment[]) {
    const entry = draftEntry, current = draft();
    if (current.loading && !attached) throw new Error('Files are still loading');
    const { revision, version } = current;
    const attachments = structuredClone(attached ?? current.attachments
      .filter(({ originalIndex }) => originalIndex === undefined).map(({ name, mimeType, data }) => ({ name, mimeType, data })));
    const removedImages = revision?.images?.flatMap((_, index) =>
      current.attachments.some(({ originalIndex }) => index === originalIndex) ? [] : [index]) ?? [];
    return { attachments, revision, removedImages, clear() {
      if (attached || current.version !== version) return;
      if (revision) { if (entry.edit === current) delete entry.edit; }
      else if (entry.input === current) entry.input = blankDraft();
      if (draftEntry === entry) renderDraft();
    } };
  }

  async function send(text: string, attached?: Attachment[]) {
    if (sending || pending) return;
    let snapshot: ReturnType<typeof snapshotDraft>;
    try { snapshot = snapshotDraft(attached); }
    catch (error) { report(error instanceof Error ? error : new Error(String(error))); return; }
    const { attachments, revision, removedImages } = snapshot;
    if (!text.trim() && !attachments.length && (revision?.images?.length ?? 0) === removedImages.length) return;
    if (!modelPicker.selected()) {
      showStatus('Choose a configured model before sending.');
      modelPicker.open();
      return;
    }
    const choice = modelDraft;
    const thinkingLevel = thinkingDraft;
    const message = commands.prepare(text);
    const signal = begin();
    const workspace = state.selectedWorkspace;
    const entry = draftEntry;
    pending = true;
    setSending(true);
    try {
      let id = active();
      if (!id) {
        if (!workspace) throw new Error('Add a workspace before starting a conversation.');
        const item = await controller.create(workspace, entry.permission ?? 'standard');
        id = item.id;
        drafts.set(id, entry);
        if (drafts.get('workspace:' + workspace) === entry) drafts.delete('workspace:' + workspace);
        await options.sessions.refresh();
        if (!signal.aborted) { showConversation(item); setSending(true); }
        else if (!active() && draftEntry === entry) switchDraft();
      }
      const run = revision && !attached
        ? await revision.submit({ text, attachments, removedImages, model: choice, thinkingLevel })
        : await controller.start(id, { message, attachments, model: choice, thinkingLevel });
      lastInputs.set(id, { message: text, attachments });
      submitted.set(id, { runId: run.id, clear: snapshot.clear });
      if (!signal.aborted) {
        modelDraft = undefined; thinkingDraft = undefined;
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
        case 'user': {
          const submission = submitted.get(item.id);
          if (submission && submission.runId === event.submissionId) {
            submission.clear();
            submitted.delete(item.id);
          }
          if (!lastInputs.has(item.id)) rememberInput(item.id, event.content);
          break;
        }
        case 'tool':
          showStatus(event.state === 'approval' ? 'Waiting for approval…' :
            event.state === 'running' ? 'Running ' + event.name + '…' : 'Thinking…');
          break;
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
    if (draft && !catalog.models.some((model) => model.configured && model.provider === draft.provider && model.id === draft.id)) {
      modelDraft = undefined;
      thinkingDraft = undefined;
    }
    const selected = modelPicker.update(catalog.models, catalog.providers,
      modelDraft ?? (sending ? conversationModel : undefined) ?? options.models.get().recent);
    const advertised = selected?.thinkingLevels ?? [];
    const levels: ThinkingLevel[] = advertised.length ? ['off', ...advertised.filter((level) => level !== 'off')] : [];
    const sameModel = selected && selected.provider === conversationModel?.provider && selected.id === conversationModel.id;
    const inherited = sameModel ? conversationThinking : undefined;
    const desired = thinkingDraft === undefined ? inherited : thinkingDraft;
    thinkingPicker.update(levels, desired);
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
    const button = element<'button'>('queueSend');
    pending = true;
    button.disabled = true;
    try {
      const snapshot = snapshotDraft();
      if (snapshot.revision) throw new Error('Finish editing before queuing a message');
      const queued = await controller.queue(id, {
        message: commands.prepare(prompt.value), mode: api.configuration.get<'steer' | 'followUp'>('queueMode'),
        attachments: snapshot.attachments, model: modelDraft, thinkingLevel: thinkingDraft
      });
      snapshot.clear();
      if (signal.aborted) return;
      modelDraft = undefined; thinkingDraft = undefined;
      updateModelControls(); showQueue(queued);
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
    finally { if (!signal.aborted) { pending = false; composerUi.render(); } }
  }
  async function cancelQueue(item?: string) {
    const id = active(), signal = visit.signal;
    if (!id) return;
    const revision = ++queueRevision;
    try {
      const queue = await controller.cancelQueue(id, item);
      if (!signal.aborted && revision === queueRevision) showQueue(queue);
    } catch (error) { if (!signal.aborted) report(error instanceof Error ? error : new Error(String(error))); }
  }
  function showQueue(queue: Queue = []) {
    queueRevision++;
    renderQueue(element('queuedMessages'), queue, cancelQueue);
  }
  api.onDispose(options.projections.register('queue', {
    async sync(_revision, reconnect, changedId) {
      const id = active(), signal = visit.signal;
      if (!id || (!reconnect && changedId && id !== changedId)) return;
      const revision = ++queueRevision;
      try {
        const queue = await controller.getQueue(id, signal);
        if (!signal.aborted && revision === queueRevision) showQueue(queue);
      } catch (error) {
        if (!signal.aborted && revision === queueRevision) throw error;
      }
    }
  }));
  api.onDispose(() => visit.abort());
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
  prompt.oninput = () => {
    draft().text = prompt.value;
    draft().version++;
    adjustPrompt();
  };

  element('queueSend').onclick = () => void queueMessage();
  return {
    outlets, activate, showConversation, clear, updateModelControls, report,
    refreshTools: messageView.refreshTools,
    refreshActions: messageView.refreshActions,
    beginDraftMode(mode: DraftMode) {
      if (sending || pending || !active()) return;
      draftEntry.edit = { ...blankDraft(), text: mode.text, revision: mode,
        attachments: (mode.images ?? []).map((file, originalIndex) => ({ ...file, originalIndex })) };
      renderDraft();
      prompt.focus();
    },
    cancelDraftMode,
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
