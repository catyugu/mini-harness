import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { UpgradeHandler } from './routes.ts';

export class Upgrades {
  private readonly admission = new AbortController();
  private readonly entries = new Map<
    string,
    { handler: UpgradeHandler; lifetime: AbortController; active: Set<Promise<void>> }
  >();

  register(path: string, handler: UpgradeHandler) {
    if (this.entries.has(path)) throw new Error('Duplicate WebSocket path: ' + path);
    const entry = { handler, lifetime: new AbortController(), active: new Set<Promise<void>>() };
    this.entries.set(path, entry);
    return async () => {
      if (this.entries.get(path) === entry) this.entries.delete(path);
      entry.lifetime.abort();
      await Promise.allSettled(entry.active);
    };
  }

  close() {
    this.admission.abort();
  }

  dispatch(path: string, request: IncomingMessage, socket: Duplex, head: Buffer) {
    const entry = this.entries.get(path);
    if (!entry || this.admission.signal.aborted) return false;
    const connection = new AbortController();
    const signal = AbortSignal.any([entry.lifetime.signal, connection.signal, this.admission.signal]);
    const cancel = () => {
      socket.destroy();
    };
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('close', () => {
      signal.removeEventListener('abort', cancel);
      connection.abort();
    });
    socket.on('error', () => socket.destroy());
    const active = Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return entry.handler(request, socket, head, signal);
      })
      .catch(() => {
        socket.destroy();
      })
      .finally(() => {
        entry.active.delete(active);
      });
    entry.active.add(active);
    return true;
  }
}
