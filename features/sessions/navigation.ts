import type { ServerResponse } from 'node:http';
import { eventStream } from '../../src/transport/http.js';
import type { SessionStore } from '../../src/contracts/services.js';
import type { Conversation } from '../../src/contracts/conversation.js';
import type { NavigationEvent } from '../../src/contracts/navigation.js';

export interface NavigationHost {
  registry: SessionStore;
  approvals?: () => { has(sessionId: string): boolean } | undefined;
}

export function navigationSession(runtime: NavigationHost, id: string) {
  const record = runtime.registry.get(id);
  return record && { ...record, waitingApproval: runtime.approvals?.()?.has(id) ?? false };
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
