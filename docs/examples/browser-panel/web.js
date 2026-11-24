import { conversationExtensions, layoutExtensions, settingsExtensions } from '/packages/ui-runtime/plugin-sdk.js';

import { replaceComposer } from './web/composer.js';

export default function setup(ctx, api) {
  const { miniPrimitives: ui, miniComposer } = ctx;
  if (api.config.replaceComposer) replaceComposer(ctx, api);
  const panel = document.createElement('section');
  panel.tabIndex = -1;
  panel.append(ui.status('Example panel is ready.'));
  const open = ui.button('Preview', 'primary');
  const modal = api.contribute(layoutExtensions.dialog, 'Example preview', ui.status('This dialog belongs to the example panel.'));
  open.addEventListener('click', () => modal.showModal(), { signal: api.signal });
  panel.append(open);
  api.contribute(layoutExtensions.page, 'example', { title: 'Example panel', content: panel });
  api.contribute(settingsExtensions.register, {
    id: 'example-info',
    section: 'Extensions',
    render: () => ui.status('The example panel can also replace the conversation composer.')
  });
  api.contribute(conversationExtensions.messageAction, {
    id: 'example-use-message', label: 'Use message in draft', icon: 'copy',
    visible: ({ message }) => message.role === 'assistant',
    run: ({ rawText }) => miniComposer.insert(rawText)
  });
}
