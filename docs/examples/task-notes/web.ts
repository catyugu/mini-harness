import type { FrontendSetup } from 'mini-harness/browser-plugin';

const sdkUrl: string = '/packages/ui-runtime/plugin-sdk.js';
const { conversationExtensions, settingsExtensions } = await import(sdkUrl) as typeof import('mini-harness/browser-plugin');

const setup: FrontendSetup = ({ miniPrimitives }, api) => {
  api.contribute(conversationExtensions.record, (record) =>
    miniPrimitives.status(record.title + ': ' + String(record.content ?? '')));
  api.contribute(conversationExtensions.tool, 'save_task_note', () => miniPrimitives.status('Saved to task notes'));
  api.contribute(settingsExtensions.register, {
    section: 'Extensions', id: 'task-notes',
    render({ bind }) {
      const input = document.createElement('input');
      const field = miniPrimitives.field('Task note label', input);
      field.append(bind<string>(input, 'label', {
        read(value) { input.value = value; },
        write() { return input.value; }
      }));
      return field;
    }
  });
};
export default setup;
