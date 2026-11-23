import type { BrowserPlugin } from '../../ui-runtime/frontend.js';
import { sessionNavigation } from './navigation.js';

export const navigationPlugin: BrowserPlugin = {
  id: 'core:navigation', inject: ['miniSelection', 'miniSessions', 'miniWorkspaces', 'miniLayout', 'miniPages', 'miniHeader', 'miniWorkspace'],
  setup(ctx, api) {
    const { miniLayout: layout, miniPages: pages, miniHeader: header, miniSelection: state, miniSessions: sessions, miniWorkspaces: workspaces, miniWorkspace: workspace } = ctx;
    sessionNavigation(api, {
      state, sessions, workspaces,
      select(id, draft) {
        const changed = state.selectedWorkspace !== id;
        state.selectWorkspace(id);
        pages.open();
        if (draft || changed) state.dispatchEvent(new Event(draft ? 'draft' : 'clear'));
        else state.changed();
        if (!draft) layout.closeDrawer();
      },
      chooseWorkspace: (onAdd) => workspace.open(workspaces.get().find(({ id }) => state.selectedWorkspace === id), onAdd),
      renameWorkspace: workspace.rename,
      removeWorkspace: workspace.remove,
      activate: (id) => state.dispatchEvent(new CustomEvent('open', { detail: id })),
      clearConversation: () => state.dispatchEvent(new Event('clear')),
      setTitle: header.setTitle,
      report: (error) => state.dispatchEvent(new CustomEvent('error', { detail: error }))
    });
  }
};


export default navigationPlugin;
