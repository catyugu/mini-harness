import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpReply, type RouteRequest, type RouteHandler, type RoutePort } from '../contracts/routes.js';

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
  private readonly routes = new Map<string, { path: string; pattern: RegExp; names: string[]; literal: boolean;
    handler: RouteHandler; signal: AbortSignal; controller: AbortController }>();

  register(method: string, path: string, handler: RouteHandler) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !/^\/[a-zA-Z0-9_:/-]+$/.test(path))
      throw new Error('Invalid route: ' + method + ' ' + path);
    const key = method + ' ' + path;
    if (this.routes.has(key)) throw new Error('Duplicate route: ' + key);
    const names: string[] = [];
    const parts = path.split('/').slice(1).map((segment) => {
      if (segment.startsWith(':')) {
        if (!/^:[a-zA-Z][a-zA-Z0-9_]*$/.test(segment)) throw new Error('Invalid route parameter');
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(segment)) throw new Error('Invalid route segment');
      return segment;
    });
    const controller = new AbortController();
    const entry = { path, pattern: new RegExp('^/' + parts.join('/') + '$'), names, literal: names.length === 0,
      handler, signal: controller.signal, controller };
    this.routes.set(key, entry);
    return () => { if (this.routes.get(key) === entry) this.routes.delete(key); controller.abort(); };
  }

  dispatch(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method;
    const path = url.pathname;
    const entries = [...this.routes.entries()].filter(([key]) => key.startsWith(method + ' '));
    const matching = entries
      .sort(([, a], [, b]) => Number(b.literal) - Number(a.literal))
      .map(([, route]) => ({ route, match: route.pattern.exec(path) }))
      .find(({ match }) => match !== null);
    if (!matching) return;
    const { route, match } = matching;
    const params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
    return Promise.resolve(route.handler({
      url, params, request: req, response: res, signal: route.signal,
      async body(max) {
        const result = await requestBody(req, max);
        route.signal.throwIfAborted();
        return result;
      }
    })).then((result) => {
      if (res.destroyed || res.writableEnded || res.headersSent) return;
      route.signal.throwIfAborted();
      if (result instanceof HttpReply) {
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store', ...result.headers });
        res.end(JSON.stringify(result.body));
      } else json(res, 200, result ?? null);
    });
  }
}
