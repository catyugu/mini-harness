import type { IncomingMessage, ServerResponse } from 'node:http';

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

export interface RouteRequest {
  url: URL;
  workspace?: { id: string; path: string };
  signal: AbortSignal;
  body(max?: number): Promise<unknown>;
}
export type RouteHandler = (request: RouteRequest) => unknown | Promise<unknown>;

export class RouteRegistry {
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
