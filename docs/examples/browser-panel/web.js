export default function setup(_ctx, api) {
  const panel = document.createElement('section');
  panel.tabIndex = -1;
  panel.append(api.ui.status('Example panel is ready.'));
  const open = api.ui.button('Preview', 'primary');
  const modal = api.dialog('Example preview', api.ui.status('This dialog belongs to the example panel.'));
  open.addEventListener('click', () => modal.showModal(), { signal: api.signal });
  panel.append(open);
  api.page('example', { title: 'Example panel', content: panel });
  api.settingsPage('Example settings', api.ui.status('The example panel requires no configuration.'));
  api.messageAction({
    id: 'example-use-message', label: 'Use message in draft', icon: 'copy',
    visible: ({ message }) => message.role === 'assistant',
    run: ({ rawText }) => api.insert(rawText)
  });
}
