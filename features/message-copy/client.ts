import type { FrontendSetup } from '../../web/kernel/extensions.js';

const setup: FrontendSetup = (api) => {
  api.messageAction({
    id: 'message-copy', label: 'Copy message', successLabel: 'Copied', icon: 'copy', order: 10,
    visible: ({ message }) => message.role === 'user' || message.role === 'assistant',
    async run({ rawText }) {
      await navigator.clipboard.writeText(rawText);
    }
  });
};
export default setup;
