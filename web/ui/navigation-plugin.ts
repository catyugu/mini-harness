import type { BrowserPlugin } from '../kernel/extensions.js';
import { sessionNavigation } from './navigation.js';

export const navigationPlugin: BrowserPlugin = {
  id: 'core:navigation', inject: ['miniState', 'miniShell', 'miniWorkspace'],
  setup(ctx, api) {
    const { miniShell: shell, miniState: state, miniWorkspace: workspace } = ctx;
    sessionNavigation(api, {
      state,
      select(id, draft) {
        const changed = state.selectedWorkspace !== id;
        state.selectWorkspace(id);
        shell.showPage();
        if (draft || changed) state.dispatchEvent(new Event(draft ? 'draft' : 'clear'));
        else state.changed();
        if (!draft) shell.closeDrawer();
      },
      chooseWorkspace: (onAdd) => workspace.open(state.workspace(), onAdd),
      renameWorkspace: workspace.rename,
      removeWorkspace: workspace.remove,
      activate: (id) => state.dispatchEvent(new CustomEvent('open', { detail: id })),
      clearConversation: () => state.dispatchEvent(new Event('clear')),
      setTitle: shell.setTitle,
      report: (error) => state.dispatchEvent(new CustomEvent('error', { detail: error }))
    });
  }
};

