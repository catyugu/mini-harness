import type { Context } from 'mini-harness/cordis';
import type { ThinkingLevel } from '@mini-harness/llm/vocabulary';
import { fromMarkup, scopedElements } from '@mini-harness/ui-primitives/primitives';
import { createModelPicker } from './model-picker.ts';
import { createThinkingPicker } from './thinking-picker.ts';

export function mountModelControls(ctx: Context, signal: AbortSignal) {
  const { miniComposer: model, miniConversation: control } = ctx;
  const root = fromMarkup(`<div class="model-controls ui-row ui-fill">
<button id="modelSelect" class="model-select ui-row" type="button">Choose model</button>
            <button id="thinkingLevel" class="model-select ui-row" type="button" aria-haspopup="listbox" aria-expanded="false" aria-controls="thinkingResults" hidden>Default</button>
            <div id="thinkingPicker" class="ui-popover model-picker thinking-picker" popover="auto"><div id="thinkingResults" role="listbox" aria-label="Thinking levels"></div></div>
  </div>`);
  const { element } = scopedElements(root);
  const modelPicker = createModelPicker(element<'button'>('modelSelect'), model.choose, signal);
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
      return false;
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
      const selected = modelPicker.update(catalog.models, catalog.providers, choice);
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
