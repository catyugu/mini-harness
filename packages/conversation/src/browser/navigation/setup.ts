import type { Context } from 'mini-harness/cordis';
import { sessionNavigation } from '../navigation.ts';
import { exportSessions } from '../session-client.ts';

const setup = (ctx: Context) => {
  const {
    miniLayout: layout,
    miniPages: pages,
    miniSelection: state,
    miniSessions: sessions,
    miniWorkspaces: workspaces,
    miniWorkspace: workspace,
  } = ctx;
  ctx.inject(['miniComposer', 'miniConversation'], (composer) => {
    composer.effect(() =>
      composer.miniComposer.command({
        name: 'export',
        group: 'Conversation',
        description: 'Export the current conversation',
        run() {
          const id = composer.miniConversation.get().session?.id;
          if (!id) throw new Error('Open a conversation to export it.');
          return exportSessions([id], composer.fiber.signal);
        },
      }),
    );
  });
  sessionNavigation(ctx, {
    state,
    sessions,
    workspaces,
    select(id, draft) {
      const changed = state.selectedWorkspace !== id;
      state.selectWorkspace(id);
      pages.open();
      if (draft || changed) state.dispatchEvent(new Event(draft ? 'draft' : 'clear'));
      else state.changed();
      if (!draft) layout.closeDrawer();
    },
    chooseWorkspace: (onAdd) =>
      workspace.open(
        workspaces.get().find(({ id }) => state.selectedWorkspace === id),
        onAdd,
      ),
    renameWorkspace: workspace.rename,
    removeWorkspace: workspace.remove,
    activate: (id) => state.dispatchEvent(new CustomEvent('open', { detail: id })),
    clearConversation: () => state.dispatchEvent(new Event('clear')),
    report: (error) => state.dispatchEvent(new CustomEvent('error', { detail: error })),
  });
};

export default {
  inject: [
    'miniSelection',
    'miniSessions',
    'miniWorkspaces',
    'miniLayout',
    'miniPages',
    'miniWorkspace',
    'miniSlots',
  ],
  provide: [],
  apply: setup,
};
