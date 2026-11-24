import type { ServerResponse } from 'node:http';

export function json(res: ServerResponse, code: number, data: unknown) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function eventStream(res: ServerResponse) {
  function start() {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15000);
    heartbeat.unref();
    res.once('close', () => clearInterval(heartbeat));
  }
  return {
    start,
    send(event: unknown) {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
      start();
      res.write(JSON.stringify(event) + '\n');
    }
  };
}
