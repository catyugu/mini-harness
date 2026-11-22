import type { FrontendSetup } from '../extensions.js';
import { icon } from '../icons.js';

const setup: FrontendSetup = (api, services) => {
  api.toolAction('delegate', ({ sessionId }) => {
    if (!sessionId || !/^[a-f0-9-]{36}$/.test(sessionId)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.append(icon('chevron'), document.createTextNode(' Open child conversation'));
    button.onclick = () => services.openConversation(sessionId);
    return button;
  });
};
export default setup;
