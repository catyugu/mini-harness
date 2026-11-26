import type { Context } from 'mini-harness/cordis';

function setup(ctx: Context) {
  ctx.effect(() =>
    ctx.miniSlots.register('conversation.composer', (signal) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.name = 'attachments';
      input.multiple = true;
      input.hidden = true;
      input.onchange = () => {
        void ctx.miniComposer.addFiles([...(input.files ?? [])]).catch(ctx.miniConversation.report);
        input.value = '';
      };
      const open = () => input.click();
      const button = ctx.miniPrimitives.iconButton('Attach files', 'attach');
      button.onclick = open;
      const remove = ctx.miniComposer.command({
        name: 'file',
        aliases: ['attach', 'upload'],
        group: 'Add',
        description: 'Upload files from your device',
        run: open,
      });
      signal.addEventListener('abort', remove, { once: true });
      const root = document.createElement('span');
      root.style.display = 'contents';
      root.append(button, input);
      return root;
    }, { order: -10 }),
  );
}

export default {
  inject: ['miniComposer', 'miniConversation', 'miniSlots', 'miniPrimitives'],
  apply: setup,
};
