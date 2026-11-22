import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RouteRequest, RouteHandler, RoutePort } from '../contracts/routes.js';

export function requestBody(req: IncomingMessage, max = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (data) => {
      size += data.length;
      if (size > max) { reject(new Error('Request too large')); req.destroy(); return; }
      chunks.push(data);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('Malformed JSON')); }
    });
    req.on('error', reject);
  });
}

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

export class RouteRegistry implements RoutePort {
  private routes = new Map<string, { handler: RouteHandler; signal: AbortSignal }>();

  register(method: string, path: string, handler: RouteHandler) {
    const key = method + ' ' + path;
    if (this.routes.has(key)) throw new Error('Duplicate route: ' + key);
    const controller = new AbortController();
    this.routes.set(key, { handler, signal: controller.signal });
    return () => { this.routes.delete(key); controller.abort(); };
  }

  dispatch(req: IncomingMessage, res: ServerResponse, url: URL, scope?: { path: string; workspace: RouteRequest['workspace'] }) {
    const route = this.routes.get(req.method + ' ' + (scope?.path ?? url.pathname));
    if (!route) return;
    return Promise.resolve(route.handler({
      url, workspace: scope?.workspace, signal: route.signal,
      async body(max) {
        const value = await requestBody(req, max);
        route.signal.throwIfAborted();
        return value;
      }
    })).then((result) => {
      route.signal.throwIfAborted();
      json(res, 200, result ?? null);
    });
  }
}
