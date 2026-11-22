import type { ServerResponse } from 'node:http';
import { eventStream } from './http.js';
import type { Conversation, SessionRegistry } from '../services/conversations.js';
import type { WorkspaceRecord } from '../services/workspaces.js';

export type NavigationEvent =
  | { type: 'snapshot'; workspaces: WorkspaceRecord[]; sessions: Conversation[] }
  | { type: 'workspaces'; workspaces: WorkspaceRecord[] }
  | { type: 'session'; session: Conversation }
  | { type: 'delete'; id: string };

export interface NavigationHost {
  registry: SessionRegistry;
  plugins: { ctx: { harnessApprovals?: { has(sessionId: string): boolean } } };
}

export function navigationSession(runtime: NavigationHost, id: string) {
  const record = runtime.registry.get(id);
  return record && { ...record, waitingApproval: runtime.plugins.ctx.harnessApprovals?.has(id) ?? false };
}

export function navigationSnapshot(runtime: NavigationHost) {
  return {
    workspaces: runtime.registry.workspaces.list(),
    sessions: runtime.registry.list().map(({ id }) => navigationSession(runtime, id))
  };
}

export function streamNavigation(runtime: NavigationHost, res: ServerResponse, signal: AbortSignal) {
  signal.throwIfAborted();
  const { send } = eventStream(res);
  const controller = new AbortController();
  const events = { signal: controller.signal };
  const shutdown = () => res.end();
  signal.addEventListener('abort', shutdown, { once: true });
  res.once('close', () => {
    controller.abort();
    signal.removeEventListener('abort', shutdown);
  });
  const registry = runtime.registry;
  registry.events.addEventListener('change', (event: CustomEvent<{ id: string; deleted: boolean }>) => {
    const { id, deleted } = event.detail;
    if (deleted) send({ type: 'delete', id });
    else {
      const session = navigationSession(runtime, id);
      if (session) send({ type: 'session', session });
    }
  }, events);
  registry.workspaces.events.addEventListener('change', () => send({ type: 'workspaces', workspaces: registry.workspaces.list() }), events);
  send({ type: 'snapshot', ...navigationSnapshot(runtime) });
}
