import type { Conversation } from '../shared/api.ts';
import type { WorkspaceRecord } from '@mini-harness/workspaces/record';

export class Selection extends EventTarget {
  selectedWorkspace: string | undefined = localStorage.getItem('mini-harness-workspace') ?? undefined;
  activeConversation: string | undefined;

  selectWorkspace(id?: string) {
    this.selectedWorkspace = id;
    if (id) localStorage.setItem('mini-harness-workspace', id);
    else localStorage.removeItem('mini-harness-workspace');
  }

  reconcileWorkspace(workspaces: WorkspaceRecord[]) {
    if (!(this.activeConversation && this.selectedWorkspace === undefined) && !workspaces.some(({ id }) => id === this.selectedWorkspace)) this.selectWorkspace(workspaces[0]?.id);
    this.changed();
  }

  initialConversation(sessions: Conversation[], workspaces: WorkspaceRecord[]) {
    const remembered = sessionStorage.getItem('mini-harness-active');
    const available = sessions.filter(({ workspaceId }) => workspaceId === null || workspaces.some(({ id }) => id === workspaceId));
    return (
      available.find(({ id }) => id === remembered) ??
      available.find(({ parentId, workspaceId }) => !parentId && workspaceId === this.selectedWorkspace) ??
      available.find(({ parentId, workspaceId }) => !parentId && workspaceId === null)
    );
  }

  scope = () =>
    this.selectedWorkspace && { workspaceId: this.selectedWorkspace, sessionId: this.activeConversation };

  selectConversation(item?: Conversation, revealWorkspace = true) {
    this.activeConversation = item?.id;
    if (item) {
      this.selectWorkspace(item.workspaceId ?? undefined);
      sessionStorage.setItem('mini-harness-active', item.id);
    } else sessionStorage.removeItem('mini-harness-active');
    this.dispatchEvent(new CustomEvent('selection', { detail: { item, revealWorkspace } }));
    this.changed();
  }

  changed() {
    this.dispatchEvent(new Event('change'));
  }
  subscribe = (listener: () => void, signal: AbortSignal) =>
    this.addEventListener('change', listener, { signal });
}
