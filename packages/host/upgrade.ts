import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { UpgradeHandler } from '@mini-harness/transport/routes';

export class Upgrades {
  private readonly entries = new Map<string, { handler: UpgradeHandler; lifetime: AbortController }>();

  register(path: string, handler: UpgradeHandler) {
    if (this.entries.has(path)) throw new Error('Duplicate WebSocket path: ' + path);
    const entry = { handler, lifetime: new AbortController() };
    this.entries.set(path, entry);
    return () => {
      if (this.entries.get(path) !== entry) return;
      this.entries.delete(path);
      entry.lifetime.abort();
    };
  }

  dispatch(path: string, request: IncomingMessage, socket: Duplex, head: Buffer) {
    const entry = this.entries.get(path);
    if (!entry) return false;
    const connection = new AbortController();
    const signal = AbortSignal.any([entry.lifetime.signal, connection.signal]);
    const cancel = () => { socket.destroy(); };
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('close', () => {
      signal.removeEventListener('abort', cancel);
      connection.abort();
    });
    socket.on('error', () => socket.destroy());
    void Promise.resolve().then(() => {
      signal.throwIfAborted();
      return entry.handler(request, socket, head, signal);
    }).catch(() => socket.destroy());
    return true;
  }
}
