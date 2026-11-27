import type { Context } from 'mini-harness/cordis';
import type { ConversationPermission } from '@mini-harness/sessions/identity';
import { bindPopover, fromMarkup, required, scopedElements } from '@mini-harness/ui-primitives/primitives';
import { messageModes, type MessageMode } from '@mini-harness/sessions/queue';
import { modeLabel } from './queue-view.ts';
import { icon } from '@mini-harness/ui-primitives/icons';
import { promptEditor } from './prompt-editor.ts';
import { createComposer } from './composer.ts';
import { isRunning } from '@mini-harness/sessions/run-state';

export function mountComposer(ctx: Context, signal: AbortSignal) {
  const { miniConversation: control, miniComposer: model } = ctx;
  const composer = fromMarkup(`<form id="composer" class="composer">
          <div id="attachments" class="attachments" hidden></div>
          <div id="suggestions" class="suggestions" role="listbox" aria-label="Input suggestions" hidden></div>
          <div id="draftMode" class="draft-mode" hidden><span></span><button type="button" aria-label="Cancel editing">Cancel</button></div>
          <div id="promptEditor"></div>
          <div class="composer-footer">
            <div class="composer-leading">
              <div id="composerExtensions" class="composer-tools"></div>
              <button id="permissionSelect" class="permission-select" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="permissionResults"></button>
              <div id="permissionPicker" class="ui-popover permission-picker" popover="auto">
                <div id="permissionResults" role="listbox" aria-label="Conversation permissions"></div>
              </div>
              <div id="composerOptions" class="composer-tools"></div>
            </div>
            <div class="composer-secondary">
              <div id="composerTrailing" class="composer-trailing"></div>
              <select id="messageMode" class="small-button" aria-label="Message sending mode" hidden></select>
              <div class="composer-actions">
                <button id="stop" type="button" aria-label="Stop response" hidden data-icon="stop"></button>
                <button id="send" type="submit" aria-label="Send" data-icon="send"></button>
              </div>
            </div>
          </div>
        </form>`) as HTMLFormElement;
  const { element } = scopedElements(composer);
  const modeSelect = element<'select'>('messageMode');
  for (const mode of messageModes) modeSelect.add(new Option(modeLabel[mode], mode));
  modeSelect.onchange = () => control.chooseMode(modeSelect.value as MessageMode);
  const editor = promptEditor(
    element('promptEditor'),
    (path) => {
      const workspaceId = ctx.miniSelection.scope()?.workspaceId;
      if (workspaceId) ctx.get('miniFilePreview')?.open({ kind: 'workspace', workspaceId, path }, 'sidebar');
    },
    signal,
  );
  const prompt = editor.element;
  const ui = createComposer(ctx, composer, editor, model, control.report, signal);
  const removeToolbar = ctx.miniSlots.define('conversation.composer', element('composerExtensions'));
  signal.addEventListener('abort', removeToolbar, { once: true });
  const removeOptions = ctx.miniSlots.define('conversation.composer-options', element('composerOptions'));
  signal.addEventListener('abort', removeOptions, { once: true });
  const removeTrailing = ctx.miniSlots.define('conversation.composer-trailing', element('composerTrailing'));
  signal.addEventListener('abort', removeTrailing, { once: true });
  const permissionButton = element<'button'>('permissionSelect');
  const permissionPopup = element('permissionPicker');
  const permissionResults = element('permissionResults');
  const permissionLabels: Record<ConversationPermission, string> = {
    standard: 'Standard',
    readOnly: 'Read-only',
    fullAccess: 'Full access',
  };
  let previousPermission: ConversationPermission | undefined;
  const permissionOptions: Array<{ value: ConversationPermission; description: string }> = [
    {
      value: 'fullAccess',
      description: 'Run enabled tools; release plugin approvals that support Full access',
    },
    {
      value: 'standard',
      description: 'Run enabled tools with normal plugin policies; Shell uses your user permissions',
    },
    { value: 'readOnly', description: 'Only tools declared read-only; no edits or Shell' },
  ];
  function renderPermission() {
    const current = model.permission();
    if (current === previousPermission) return;
    previousPermission = current;
    const label = permissionLabels[current];
    permissionButton.replaceChildren(
      icon(current === 'readOnly' ? 'lock' : current === 'fullAccess' ? 'unlock' : 'shield'),
      document.createTextNode(label),
      icon('chevron'),
    );
    permissionButton.setAttribute('aria-label', 'Permissions: ' + label);
    permissionButton.title = 'Conversation permissions: ' + label;
    permissionResults.replaceChildren(
      ...permissionOptions.map(({ value, description }) => {
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
          try {
            await model.setPermission(value);
          } catch (error) {
            control.report(error instanceof Error ? error : new Error(String(error)));
          } finally {
            permissionButton.disabled = false;
          }
        };
        return option;
      }),
    );
  }
  const positionPermission = bindPopover(permissionButton, permissionPopup, signal, {
    width: 290,
    prefer: 'above',
  });
  permissionButton.onclick = () => {
    if (permissionPopup.matches(':popover-open')) permissionPopup.hidePopover();
    else {
      permissionPopup.showPopover();
      positionPermission();
      permissionResults.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    }
  };

  let previousDraftScope = '';
  function render(focus = false) {
    const current = model.draft(),
      state = control.get();
    const running = isRunning(state.run);
    const draftScope = state.session?.id ?? 'workspace:' + ctx.miniSelection.selectedWorkspace;
    if (previousDraftScope !== draftScope || editor.value !== current.text) {
      previousDraftScope = draftScope;
      editor.sync(current.text, model.cursor());
      ui.resetSuggestions();
    }
    const banner = element('draftMode');
    banner.hidden = !current.editTitle;
    required(banner.querySelector('span')).textContent = current.editTitle ?? '';
    const sendButton = element<'button'>('send');
    const sendLabel = running ? 'Send with ' + modeLabel[state.mode] : 'Send';
    sendButton.setAttribute('aria-label', sendLabel);
    sendButton.title = sendLabel;
    modeSelect.hidden = !running;
    modeSelect.value = state.mode;
    element<'button'>('stop').hidden = !running;
    element<'button'>('stop').disabled = Boolean(state.interaction.cancelling);
    ui.render(Boolean(state.interaction.operation));
    renderPermission();
    if (focus) {
      editor.focus();
      editor.select(model.cursor());
      ui.refresh(true);
    }
  }
  async function send() {
    if (control.get().interaction.operation || model.draft().awaitingAcceptance) return;
    if (!model.draft().text.trim() && !model.draft().attachments.length) return;
    if (ui.submitCommand()) return;
    if (ctx.bail('composer/before-send') === false) return;
    try {
      await model.send();
    } catch (error) {
      control.report(error instanceof Error ? error : new Error(String(error)));
    }
  }
  required(element('draftMode').querySelector('button')).onclick = model.cancelEdit;
  composer.onsubmit = (event) => {
    event.preventDefault();
    void send();
  };
  prompt.addEventListener(
    'keydown',
    (event) => {
      if (
        !event.defaultPrevented &&
        event.key === 'Enter' &&
        !event.shiftKey &&
        !event.isComposing &&
        !editor.composing &&
        event.keyCode !== 229
      ) {
        event.preventDefault();
        composer.requestSubmit();
      }
    },
    { capture: true, signal },
  );
  prompt.addEventListener('draft-change', () => model.setText(editor.value, editor.start, editor.end), {
    signal,
  });
  element('stop').onclick = () => void control.cancel().catch(control.report);
  model.subscribe((focus) => {
    render(focus);
    ui.refresh(true);
  }, signal);
  control.subscribe(['session', 'run', 'interaction', 'mode'], () => render(), signal);
  ctx.miniSelection.addEventListener('focus-composer', () => editor.focus(), { signal });
  render();
  return composer;
}
