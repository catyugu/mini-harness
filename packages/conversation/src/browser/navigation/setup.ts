import type {} from '@mini-harness/ui-layout/browser/api';
import type {} from '@mini-harness/workspaces/browser/api';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend-api';
import { sessionNavigation } from '../navigation.js';

const setup: FrontendSetup = (ctx, api) => {
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
};


export default setup;
