import type { Context } from 'mini-harness/cordis';
import type { ComposerModel } from 'mini-harness/conversation/composer';
import type { ConversationController } from 'mini-harness/conversation/controller';
import type { SlotRenderer } from 'mini-harness/ui-slots';

export function replaceComposer(ctx: Context) {
  const model: ComposerModel = ctx.miniComposer;
  const conversation: ConversationController = ctx.miniConversation;
  const renderComposer: SlotRenderer = (signal) => {
    const form = document.createElement('form');
    const prompt = document.createElement('textarea');
    prompt.setAttribute('aria-label', 'Replacement message');
    prompt.addEventListener(
      'input',
      () => model.setText(prompt.value, prompt.selectionStart, prompt.selectionEnd),
      { signal },
    );

    const files = document.createElement('input');
    files.type = 'file';
    files.multiple = true;
    files.setAttribute('aria-label', 'Replacement attachments');
    files.addEventListener(
      'change',
      () => {
        void model.addFiles([...(files.files ?? [])]).catch(conversation.report);
        files.value = '';
      },
      { signal },
    );
    const attachments = document.createElement('div');
    const send = document.createElement('button');
    send.textContent = 'Send replacement message';
    form.addEventListener(
      'submit',
      (event) => {
        event.preventDefault();
        void model.send().catch(conversation.report);
      },
      { signal },
    );
    form.append(prompt, files, attachments, send);

    function render() {
      const { text, attachments: selected, loading, awaitingAcceptance } = model.draft();
      if (prompt.value !== text) prompt.value = text;
      attachments.replaceChildren(
        ...selected.map(({ name }, index) => {
          const remove = document.createElement('button');
          remove.type = 'button';
          remove.textContent = 'Remove ' + name;
          remove.addEventListener('click', () => model.removeAttachment(index), { signal });
          return remove;
        }),
      );
      send.disabled = loading || awaitingAcceptance || Boolean(conversation.get().interaction.operation);
    }
    model.subscribe(render, signal);
    conversation.subscribe(['interaction'], render, signal);
    render();
    return form;
  };
  ctx.effect(() => ctx.miniSlots.registerKeyed('conversation.composer-view', 'composer', renderComposer));
}
