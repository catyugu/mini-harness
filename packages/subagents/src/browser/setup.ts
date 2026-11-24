import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/conversation/browser/navigation-api';
import { icon } from '@mini-harness/ui-primitives/icons';

const setup = (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const services = ctx.harnessBrowser;
  const trail = document.createElement('nav');
  trail.className = 'parent-conversations';
  trail.setAttribute('aria-label', 'Parent conversations');
  const renderTrail = () => {
    const parents = [];
    for (let id = services.session()?.parentId; id;) {
      const parent = services.session(id);
      if (!parent) break;
      parents.unshift(parent);
      id = parent.parentId;
    }
    trail.hidden = !parents.length;
    trail.replaceChildren(...parents.map(({ id, title }) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'link-button';
      button.title = title;
      button.textContent = title;
      button.onclick = () => services.openConversation(id);
      const step = document.createElement('span');
      step.append(button, icon('chevron'));
      return step;
    }));
  };
  ctx.effect(() => ctx.miniSlots.register('conversation.header', trail));
  services.onConversationChange(renderTrail, signal);
  renderTrail();
  ctx.effect(() => ctx.miniMessages.registerTool('delegate', ({ sessionId }) => {
    if (!sessionId || !/^[a-f0-9-]{36}$/.test(sessionId)) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'link-button';
    button.append(icon('chevron'), document.createTextNode(' Open child conversation'));
    button.onclick = () => services.openConversation(sessionId);
    return button;
  }, true));
};
export default { inject: ['harnessBrowser','miniMessages','miniSlots'], provide: [], apply: setup };
