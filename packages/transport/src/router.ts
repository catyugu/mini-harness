import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, HttpReply, type RouteHandler, type RoutePort } from './routes.js';
import { json } from './http.js';

function requestBody(req: IncomingMessage, max = 1024 * 1024, signal?: AbortSignal): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const clear = () => {
      req.off('data', receive).off('end', finish).off('error', fail);
      signal?.removeEventListener('abort', cancel);
    };
    const fail = (error: Error) => {
      clear();
      reject(error);
    };
    const cancel = () => {
      fail(signal?.reason ?? new Error('Request aborted'));
      req.resume();
    };
    const receive = (data: Buffer) => {
      size += data.length;
      if (size > max) {
        fail(new HttpError('payload_too_large', 'Request too large'));
        req.resume();
        return;
      }
      chunks.push(data);
    };
    const finish = () => {
      clear();
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError('invalid_input', 'Malformed JSON'));
      }
    };

    if (signal?.aborted) {
      cancel();
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    req.on('data', receive).once('end', finish).once('error', fail);
  });
}

export class RouteRegistry implements RoutePort {
  private readonly admission = new AbortController();
  private readonly routes = new Map<
    string,
    {
      path: string;
      pattern: RegExp;
      names: string[];
      literal: boolean;
      handler: RouteHandler;
      controller: AbortController;
      active: Set<Promise<unknown>>;
    }
  >();

  register(method: string, path: string, handler: RouteHandler) {
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) || !/^\/[a-zA-Z0-9_:/-]+$/.test(path))
      throw new Error('Invalid route: ' + method + ' ' + path);
    const key = method + ' ' + path;
    if (this.routes.has(key)) throw new Error('Duplicate route: ' + key);
    const names: string[] = [];
    const parts = path
      .split('/')
      .slice(1)
      .map((segment) => {
        if (segment.startsWith(':')) {
          if (!/^:[a-zA-Z][a-zA-Z0-9_]*$/.test(segment)) throw new Error('Invalid route parameter');
          names.push(segment.slice(1));
          return '([^/]+)';
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(segment)) throw new Error('Invalid route segment');
        return segment;
      });
    const controller = new AbortController();
    const entry = {
      path,
      pattern: new RegExp('^/' + parts.join('/') + '$'),
      names,
      literal: names.length === 0,
      handler,
      controller,
      active: new Set<Promise<unknown>>(),
    };
    this.routes.set(key, entry);
    return async () => {
      if (this.routes.get(key) === entry) this.routes.delete(key);
      controller.abort(new HttpError('invalid_input', 'Route is no longer available'));
      await Promise.allSettled(entry.active);
    };
  }

  seal() {
    this.admission.abort(new HttpError('unavailable', 'Application is closing'));
  }

  async drain() {
    await Promise.allSettled([...this.routes.values()].flatMap(({ active }) => [...active]));
  }

  dispatch(req: IncomingMessage, res: ServerResponse, url: URL) {
    this.admission.signal.throwIfAborted();
    const method = req.method;
    const path = url.pathname;
    const entries = [...this.routes.entries()].filter(([key]) => key.startsWith(method + ' '));
    const matching = entries
      .sort(([, a], [, b]) => Number(b.literal) - Number(a.literal))
      .map(([, route]) => ({ route, match: route.pattern.exec(path) }))
      .find(({ match }) => match !== null);
    if (!matching) return;
    const { route, match } = matching;
    if (!match) return;
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(route.names.map((name, i) => [name, decodeURIComponent(match[i + 1])]));
    } catch {
      throw new HttpError('invalid_input', 'Invalid URL encoding');
    }
    const disconnect = new AbortController();
    const signal = AbortSignal.any([route.controller.signal, disconnect.signal, this.admission.signal]);
    const close = () => {
      if (res.headersSent) res.end();
    };
    signal.addEventListener('abort', close, { once: true });
    res.once('close', () => {
      signal.removeEventListener('abort', close);
      disconnect.abort();
    });
    const active = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return route.handler({
        url,
        params,
        request: req,
        response: res,
        signal,
        async body(max) {
          const result = await requestBody(req, max, signal);
          signal.throwIfAborted();
          return result;
        },
      });
    });
    route.active.add(active);
    return active
      .then((result) => {
        if (res.destroyed || res.writableEnded || res.headersSent) return;
        signal.throwIfAborted();
        if (result instanceof HttpReply) {
          res.writeHead(result.status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...result.headers,
          });
          res.end(JSON.stringify(result.body));
        } else json(res, 200, result ?? null);
      })
      .finally(() => {
        route.active.delete(active);
      });
  }
}
