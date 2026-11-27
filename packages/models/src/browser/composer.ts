import type { Context } from 'mini-harness/cordis';
import type { ThinkingLevel } from '@mini-harness/llm/vocabulary';
import { fromMarkup } from '@mini-harness/ui-primitives/primitives';
import { createThinkingPicker } from './thinking-picker.ts';

export function mountModelControls(ctx: Context, signal: AbortSignal) {
  const { miniComposer: model, miniConversation: control } = ctx;
  const root = fromMarkup(`<div class="model-controls ui-row">
            <button id="thinkingLevel" class="ui-button ui-fixed model-select" data-variant="quiet" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="thinkingResults" hidden>Default</button>
            <div id="thinkingPicker" class="ui-popover model-picker thinking-picker" popover="auto"><div id="thinkingResults" role="listbox" aria-label="Thinking levels"></div></div>
  </div>`);
  const modelPicker = ctx.miniModels.createPicker(model.choose, signal, { variant: 'quiet' });
  root.prepend(modelPicker.node);
  const thinkingPicker = createThinkingPicker(root, model.chooseThinking, signal);
  const removeCommand = model.command({
    name: 'model',
    group: 'Conversation',
    description: 'Choose a configured model',
    run: modelPicker.open,
  });
  signal.addEventListener('abort', removeCommand, { once: true });
  const running = () => {
    const state = control.get().run?.state;
    return state === 'queued' || state === 'running' || state === 'waiting';
  };
  const removeValidation = ctx.on('composer/before-send', () => {
    if (!running() && !modelPicker.selected()) {
      control.report(new Error('Choose a configured model before sending.'));
      modelPicker.open();
      return true;
    }
  });
  signal.addEventListener('abort', removeValidation, { once: true });
  let previousCatalog: ReturnType<typeof ctx.miniModels.get> | undefined;
  let previousModel: ReturnType<typeof model.draft>['model'],
    previousThinking: ThinkingLevel | null | undefined;
  function render() {
    const current = model.draft(),
      state = control.get();
    const sending = running() || state.interaction.operation === 'submit';
    const catalog = ctx.miniModels.get();
    const choice = current.model ?? (sending ? state.session?.model : undefined) ?? catalog.recent;
    const same = choice.provider === state.session?.model?.provider && choice.id === state.session.model.id;
    const thinking =
      current.thinkingLevel === undefined
        ? same
          ? state.session?.thinkingLevel
          : undefined
        : current.thinkingLevel;
    if (
      previousCatalog !== catalog ||
      previousModel?.provider !== choice.provider ||
      previousModel.id !== choice.id ||
      previousThinking !== thinking
    ) {
      previousCatalog = catalog;
      previousModel = choice;
      previousThinking = thinking;
      const selected = modelPicker.update(choice);
      const advertised = selected?.thinkingLevels ?? [];
      const levels: ThinkingLevel[] = advertised.length
        ? ['off', ...advertised.filter((level) => level !== 'off')]
        : [];
      thinkingPicker.update(levels, thinking);
    }
  }
  model.subscribe(render, signal);
  control.subscribe(['session', 'run', 'interaction'], render, signal);
  ctx.miniModels.subscribe(render, signal);
  render();
  return root;
}
