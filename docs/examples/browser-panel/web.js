import { conversationExtensions, layoutExtensions, settingsExtensions } from '/packages/ui-runtime/plugin-sdk.js';

export default function setup({ miniPrimitives: ui, miniComposer }, api) {
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
    render: () => ui.status('The example panel requires no configuration.')
  });
  api.contribute(conversationExtensions.messageAction, {
    id: 'example-use-message', label: 'Use message in draft', icon: 'copy',
    visible: ({ message }) => message.role === 'assistant',
    run: ({ rawText }) => miniComposer.insert(rawText)
  });
}
