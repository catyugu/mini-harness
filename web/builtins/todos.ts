import type { TodoItem } from '../../src/protocol.js';
import type { FrontendSetup } from '../extensions.js';

const setup: FrontendSetup = (api, services) => {
  const dock = document.createElement('section');
  dock.className = 'todo-dock'; dock.setAttribute('aria-label', 'Conversation tasks'); dock.hidden = true;
  api.contribute('conversation.input.dock', { id: 'todos', value: dock, order: -10 });
  let generation = 0;
  const render = (items: TodoItem[]) => {
    dock.hidden = !items.length;
    const heading = document.createElement('strong');
    heading.textContent = 'Tasks · ' + items.filter(({ state }) => state === 'completed').length + '/' + items.length;
    const list = document.createElement('ul');
    for (const item of items) {
      const row = document.createElement('li'); row.dataset.state = item.state;
      row.textContent = (item.state === 'completed' ? '✓ ' : item.state === 'in-progress' ? '◉ ' : '○ ') + item.text;
      list.append(row);
    }
    dock.replaceChildren(heading, list);
  };
  const refresh = async () => {
    const current = ++generation;
    const sessionId = services.workspace()?.sessionId;
    render([]);
    if (!sessionId) return;
    try {
      const items = await api.request<TodoItem[]>('/todos?sessionId=' + sessionId);
      if (current === generation && !api.signal.aborted) render(items);
    } catch (error) { if (current === generation && !api.signal.aborted) services.report(error); }
  };
  services.onConversationChange(() => void refresh(), api.signal);
  services.onRunEvent((event) => { if (event.type === 'todos') { ++generation; render(event.items); } }, api.signal);
  void refresh();
};
export default setup;
