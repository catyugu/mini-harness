import { browserRequest } from '@mini-harness/ui-runtime/http';
import type { Context } from 'mini-harness/cordis';
import type {} from './api.js';
import type {} from '@mini-harness/workspaces/browser/api';
import type {} from '@mini-harness/ui-runtime/projection-api';
import type { Conversation } from '../../shared/api.js';
import type { ConversationBrowserPort } from '../navigation-api.js';
import { RemoteStore } from '@mini-harness/ui-runtime/remote-store';
import { Selection } from '../selection.js';

const setup = async (ctx: Context) => {
  const signal = ctx.fiber.signal;
  const byRecent = (a: Conversation, b: Conversation) => b.updatedAt.localeCompare(a.updatedAt);
  const sessions = new RemoteStore(async () => (await browserRequest<Conversation[]>(ctx, '/sessions')).sort(byRecent), {
    fetch: (ids) => browserRequest<Conversation[]>(ctx, '/sessions?' + new URLSearchParams(ids.map((id) => ['id', id]))),
    merge: (current, updated, ids) => [...current.filter(({ id }) => !ids.has(id)), ...updated].sort(byRecent)
  });
  await sessions.refresh();
  const selection = new Selection();
  const workspaces = ctx.miniWorkspaces;
  selection.reconcileWorkspace(workspaces.get());
  workspaces.subscribe(() => selection.reconcileWorkspace(workspaces.get()), signal);
  const report = (error: Error) => selection.dispatchEvent(new CustomEvent('error', { detail: error }));
  window.addEventListener('mini-harness:error', (event: Event) => {
    if (event instanceof CustomEvent && event.detail instanceof Error) report(event.detail);
  }, { signal });
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
  ctx.effect(() => ctx.miniProjections.register('sessions', sessions));
  ctx.provide('miniSessions', sessions);
  ctx.provide('miniSelection', selection);
  ctx.provide('harnessBrowser', browser);
};

export default { inject: ['miniProjections','miniWorkspaces'], provide: ['miniSessions','miniSelection','harnessBrowser'], apply: setup };
