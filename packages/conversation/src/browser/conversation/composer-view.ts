import type { Context } from 'cordis';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import type { ThinkingLevel } from '@mini-harness/llm/vocabulary';
import { fromMarkup, required, scopedElements } from '@mini-harness/ui-primitives/primitives';
import { icon } from '@mini-harness/ui-primitives/icons';
import { createComposer } from './composer.js';
import { isRunning } from '@mini-harness/sessions/run-state';
import { createModelPicker } from './model-picker.js';
import { createThinkingPicker } from './thinking-picker.js';

export function mountComposer(ctx: Context, signal: AbortSignal) {
  const { miniConversation: control, miniComposer: model } = ctx;
  const composer = fromMarkup(`<form id="composer" class="composer">
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
        </form>`) as HTMLFormElement;
  const { element } = scopedElements(composer);
  const prompt = element<'textarea'>('prompt');
  const adjustPrompt = () => {
    prompt.style.height = 'auto';
    prompt.style.height = Math.min(prompt.scrollHeight, 210) + 'px';
  };
  const ui = createComposer(composer, model, control.report, signal);
  const modelPicker = createModelPicker(composer, model.choose, signal);
  const thinkingPicker = createThinkingPicker(composer, model.chooseThinking, signal);
  const removeToolbar = ctx.miniSlots.define('conversation.composer', element('composerExtensions'));
  signal.addEventListener('abort', removeToolbar, { once: true });
  const removeAttachment = ctx.miniSlots.register('conversation.composer', ui.attachmentButton());
  signal.addEventListener('abort', removeAttachment, { once: true });
  const removeFileCommand = model.command({ name: 'file', aliases: ['attach', 'upload'], group: 'Add',
    description: 'Upload files from your device', run: ui.openFiles });
  signal.addEventListener('abort', removeFileCommand, { once: true });
  const removeModelCommand = model.command({ name: 'model', group: 'Conversation', description: 'Choose a configured model', run: modelPicker.open });
  signal.addEventListener('abort', removeModelCommand, { once: true });
  const permissionButton = element<'button'>('permissionSelect');
  const permissionPopup = element('permissionPicker');
  const permissionResults = element('permissionResults');
  const permissionLabels: Record<ConversationPermission, string> = {
    standard: 'Standard', readOnly: 'Read-only', fullAccess: 'Full access'
  };
  let previousPermission: ConversationPermission | undefined;
  const permissionOptions: Array<{ value: ConversationPermission; description: string }> = [
    { value: 'fullAccess', description: 'Run enabled tools without approval prompts, including Shell' },
    { value: 'standard', description: 'Ask before Shell commands; follow existing tool policies' },
    { value: 'readOnly', description: 'Only read files, search and load skills; no edits or Shell' }
  ];
  function renderPermission() {
    const current = model.permission();
    if (current === previousPermission) return;
    previousPermission = current;
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
        if (value === model.permission()) return;
        permissionButton.disabled = true;
        try { await model.setPermission(value); }
        catch (error) { control.report(error instanceof Error ? error : new Error(String(error))); }
        finally { permissionButton.disabled = false; }
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
  permissionPopup.addEventListener('toggle', () => permissionButton.setAttribute('aria-expanded', String(permissionPopup.matches(':popover-open'))), { signal: signal });

  let previousCatalog: ReturnType<typeof ctx.miniModels.get> | undefined;
  let previousModel: ReturnType<typeof model.draft>['model'], previousThinking: ThinkingLevel | null | undefined;
  function render(focus = false) {
    const current = model.draft(), state = control.get();
    const sending = isRunning(state.run) || state.interaction.operation === 'submit';
    if (prompt.value !== current.text) {
      prompt.value = current.text;
      ui.resetSuggestions();
      adjustPrompt();
    }
    const banner = element('draftMode');
    banner.hidden = !current.editTitle;
    required(banner.querySelector('span')).textContent = current.editTitle ?? '';
    element<'button'>('send').hidden = sending;
    element('queueSend').hidden = !sending;
    element<'button'>('stop').hidden = !isRunning(state.run);
    element<'button'>('stop').disabled = Boolean(state.interaction.cancelling);
    ui.render(Boolean(state.interaction.operation));
    renderPermission();
    const catalog = ctx.miniModels.get();
    const choice = current.model ?? (sending ? state.session?.model : undefined) ?? catalog.recent;
    const same = choice.provider === state.session?.model?.provider && choice.id === state.session.model.id;
    const thinking = current.thinkingLevel === undefined ? same ? state.session?.thinkingLevel : undefined : current.thinkingLevel;
    if (previousCatalog !== catalog || previousModel?.provider !== choice.provider || previousModel.id !== choice.id || previousThinking !== thinking) {
      previousCatalog = catalog; previousModel = choice; previousThinking = thinking;
      const selected = modelPicker.update(catalog.models, catalog.providers, choice);
      const advertised = selected?.thinkingLevels ?? [];
      const levels: ThinkingLevel[] = advertised.length ? ['off', ...advertised.filter((level) => level !== 'off')] : [];
      thinkingPicker.update(levels, thinking);
    }
    if (focus) { prompt.focus(); prompt.setSelectionRange(model.cursor(), model.cursor()); ui.refresh(true); }
  }
  async function send(queued = false) {
    if (control.get().interaction.operation || model.draft().awaitingAcceptance) return;
    if (!queued && !modelPicker.selected()) { control.report(new Error('Choose a configured model before sending.')); modelPicker.open(); return; }
    try { await model.send(queued); }
    catch (error) { control.report(error instanceof Error ? error : new Error(String(error))); }
  }
  required(element('draftMode').querySelector('button')).onclick = model.cancelEdit;
  composer.onsubmit = (event) => { event.preventDefault(); void send(); };
  prompt.onkeydown = (event) => {
    if (!event.defaultPrevented && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (isRunning(control.get().run)) void send(true); else composer.requestSubmit();
    }
  };
  const syncText = () => model.setText(prompt.value, prompt.selectionStart, prompt.selectionEnd);
  prompt.oninput = () => { syncText(); adjustPrompt(); };
  prompt.addEventListener('select', syncText, { signal });
  prompt.addEventListener('click', syncText, { signal });
  element('queueSend').onclick = () => void send(true);
  element('stop').onclick = () => void control.cancel().catch(control.report);
  model.subscribe((focus) => { render(focus); ui.refresh(true); }, signal);
  control.subscribe(['session', 'run', 'interaction'], () => render(), signal);
  ctx.miniSelection.addEventListener('focus-composer', () => prompt.focus(), { signal });
  ctx.miniModels.subscribe(() => render(), signal);
  render();
  return composer;
}
