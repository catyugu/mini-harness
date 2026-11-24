import type { Conversation } from '@mini-harness/contracts/conversation';
import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import type { ConversationBrowserPort } from '@mini-harness/contracts/conversation';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import { Selection } from './selection.js';

const setup: FrontendSetup = async (ctx, api) => {
  const byRecent = (a: Conversation, b: Conversation) => b.updatedAt.localeCompare(a.updatedAt);
  const sessions = new RemoteStore(async () => (await api.request<Conversation[]>('/sessions')).sort(byRecent), {
    fetch: (ids) => api.request<Conversation[]>('/sessions?' + new URLSearchParams(ids.map((id) => ['id', id]))),
    merge: (current, updated, ids) => [...current.filter(({ id }) => !ids.has(id)), ...updated].sort(byRecent)
  });
  await sessions.refresh();
  const selection = new Selection();
  const workspaces = ctx.miniWorkspaces;
  selection.reconcileWorkspace(workspaces.get());
  workspaces.subscribe(() => selection.reconcileWorkspace(workspaces.get()), api.signal);
  const report = (error: Error) => selection.dispatchEvent(new CustomEvent('error', { detail: error }));
  window.addEventListener('mini-harness:error', (event: Event) => {
    if (event instanceof CustomEvent && event.detail instanceof Error) report(event.detail);
  }, { signal: api.signal });
  const browser: ConversationBrowserPort = {
    workspace: () => selection.scope() || undefined,
    workspaceRecord: (id) => workspaces.get().find((record) => record.id === id),
    session: (id = selection.activeConversation) => sessions.get().find((item) => item.id === id),
    onConversationChange(listener, signal) {
      selection.subscribe(listener, signal);
      sessions.subscribe(listener, signal);
    },
    openConversation: (id) => selection.dispatchEvent(new CustomEvent('open', { detail: id })),
    report
  };
  api.onDispose(ctx.miniProjections.register('sessions', sessions));
  ctx.provide('miniSessions', sessions);
  ctx.provide('miniSelection', selection);
  ctx.provide('harnessBrowser', browser);
};

declare module 'cordis' {
  interface Context {
    miniSessions: RemoteStore<Conversation[]>;
    miniSelection: Selection;
  }
}

export default setup;
