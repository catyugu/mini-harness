import type { ServerResponse } from 'node:http';
import type { MiniHarnessRuntime } from './agent.js';
import type { Conversation } from './registry.js';
import type { WorkspaceRecord } from './workspace-catalog.js';

export type NavigationEvent =
  | { type: 'snapshot'; workspaces: WorkspaceRecord[]; sessions: Conversation[] }
  | { type: 'workspaces'; workspaces: WorkspaceRecord[] }
  | { type: 'session'; session: Conversation }
  | { type: 'delete'; id: string };

export function navigationSession(runtime: MiniHarnessRuntime, id: string) {
  const record = runtime.registry.get(id);
  return record && { ...record, waitingApproval: runtime.plugins.ctx.harnessApprovals?.has(id) ?? false };
}

export function navigationSnapshot(runtime: MiniHarnessRuntime) {
  return {
    workspaces: runtime.registry.workspaces.list(),
    sessions: runtime.registry.list().map(({ id }) => navigationSession(runtime, id))
  };
}

export function streamNavigation(runtime: MiniHarnessRuntime, res: ServerResponse, signal: AbortSignal) {
  signal.throwIfAborted();
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  const send = (event: NavigationEvent) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
    res.write(JSON.stringify(event) + '\n');
  };
  const controller = new AbortController();
  const events = { signal: controller.signal };
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15000);
  heartbeat.unref();
  const shutdown = () => res.end();
  signal.addEventListener('abort', shutdown, { once: true });
  res.once('close', () => {
    controller.abort();
    signal.removeEventListener('abort', shutdown);
    clearInterval(heartbeat);
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
