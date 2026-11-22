import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { getPaths } from './config.js';
import { supportsIsolation } from './sandbox.js';
import { MiniHarnessRuntime } from './agent.js';
import { isRunning } from './protocol.js';

declare module 'cordis' {
  interface Context {
    harnessWeb: Server;
  }
}

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const assets = new Map([
  ['index.html', 'text/html'], ['app.js', 'text/javascript'], ['markdown.js', 'text/javascript'],
  ...['api', 'extensions', 'icons', 'settings-fields', 'messages'].map((name): [string, string] => [name + '.js', 'text/javascript']),
  ['vendor/marked.js', 'text/javascript'], ['vendor/purify.js', 'text/javascript'],
  ['style.css', 'text/css'], ['logo.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
  ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['favicon.ico', 'image/x-icon']
]);

export function authorize(request: IncomingMessage, token: string) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const supplied = Buffer.from(auth.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function requestBody(req: IncomingMessage, max: number = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks = [];
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

export async function createMiniHarnessServer(paths: ReturnType<typeof getPaths>, options: { token?: string; shutdown?: () => void } = {}) {
  const runtime = new MiniHarnessRuntime(paths);
  await runtime.start();
  const isolation = supportsIsolation();
  const token = options.token ?? randomBytes(32).toString('hex');
  const streamRun = (res: ServerResponse, id: string, runId: string, after: number) => {
    let detach = () => {};
    const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n'); }, 15000);
    heartbeat.unref();
    const cleanup = () => { clearInterval(heartbeat); detach(); };
    res.once('close', cleanup);
    try {
      detach = runtime.watchRun(id, runId, after, (event) => {
        if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        if (res.destroyed || res.writableEnded) return;
        // Slow or disconnected observers can reconnect from their cursor.
        if (res.writableLength > 1024 * 1024) { res.destroy(); return; }
        res.write(JSON.stringify(event) + '\n');
        if ((event.type === 'run' || event.type === 'snapshot') && !isRunning(event.run)) res.end();
      });
      if (!res.headersSent) {
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
        res.flushHeaders();
      }
    } catch (error) { cleanup(); throw error; }
  };
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
        const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        const mime = assets.get(requested);
        if (!mime) return json(res, 404, { error: 'Not found' });
        const path = join(WEB_DIR, requested);
        const size = statSync(path).size;
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8',
          'Content-Length': size, 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'Referrer-Policy': 'no-referrer' });
        return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
      }
      if (!authorize(req, token)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).origin !== 'http://' + req.headers.host) {
        return json(res, 403, { error: 'Origin not allowed' });
      }
      if (pathname === '/api/status' && req.method === 'GET') return json(res, 200, { pid: process.pid });
      if (pathname === '/api/shutdown' && req.method === 'POST' && options.shutdown) {
        res.once('finish', options.shutdown);
        return json(res, 202, { pid: process.pid });
      }
      if (pathname === '/api/bootstrap' && req.method === 'GET')
        return json(res, 200, { settings: runtime.settings, sessions: runtime.registry.list().map((item) => ({ ...item, run: runtime.runInfo(item.id) })), models: runtime.availableModels(), plugins: runtime.plugins.metadata(), workspace: paths.cwd, isolation });
      if (pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, runtime.registry.list().map((item) => ({ ...item, run: runtime.runInfo(item.id) })));
      if (pathname === '/api/sessions' && req.method === 'POST') return json(res, 201, runtime.registry.create());
      const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(messages|cancel|runs|events))?$/.exec(pathname);
      if (match) {
        const id = match[1];
        if (!runtime.registry.get(id)) return json(res, 404, { error: 'Conversation not found' });
        if (!match[2] && req.method === 'GET') return json(res, 200, await runtime.getConversation(id));
        if (match[2] === 'cancel' && req.method === 'POST') return json(res, 200, { cancelled: runtime.cancel(id) });
        if (match[2] === 'runs' && req.method === 'GET') return json(res, 200, { run: runtime.runInfo(id) ?? null });
        if (match[2] === 'runs' && req.method === 'POST') {
          const input = await requestBody(req);
          return json(res, 202, runtime.startRun(id, input.message, input.model));
        }
        if (match[2] === 'events' && req.method === 'GET') {
          await runtime.open(id);
          streamRun(res, id, url.searchParams.get('run'), Number(url.searchParams.get('after') ?? 0));
          return;
        }
        if (match[2] === 'messages' && req.method === 'POST') {
          const input = await requestBody(req);
          const run = runtime.startRun(id, input.message, input.model);
          streamRun(res, id, run.id, 0);
          return;
        }
      }
      if (pathname === '/api/sessions/delete' && req.method === 'POST') {
        const input = await requestBody(req);
        return json(res, 200, { deleted: await runtime.delete(input.ids) });
      }
      if (pathname === '/api/sessions/export' && req.method === 'POST') {
        const input = await requestBody(req);
        if (!Array.isArray(input.ids) || input.ids.length > 200) return json(res, 400, { error: 'Invalid selection' });
        const records = runtime.export(input.ids);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="mini-harness-sessions.json"', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), sessions: records }, null, 2));
      }
      if (pathname === '/api/settings' && req.method === 'PATCH') {
        const input = await requestBody(req);
        return json(res, 200, await runtime.updateSettings(input));
      }
      if (pathname === '/api/credentials' && req.method === 'POST') {
        const input = await requestBody(req);
        if (typeof input.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider) ||
            typeof input.key !== 'string' || !input.key.trim()) return json(res, 400, { error: 'Invalid credential' });
        if (!runtime.models.getProvider(input.provider)) return json(res, 400, { error: 'Unknown provider' });
        await runtime.models.login(input.provider, 'api_key', {
          prompt: async (prompt) => {
            if (prompt.type !== 'secret') throw new Error('This provider requires additional credential setup through Pi');
            return input.key.trim();
          },
          notify: () => {}
        });
        return json(res, 200, { ok: true, persisted: true, models: runtime.availableModels(), status: runtime.models.getProviderAuthStatus(input.provider) });
      }
      if (pathname === '/api/models' && req.method === 'GET') {
        await runtime.models.getAvailable();
        return json(res, 200, { models: runtime.availableModels() });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error.message === 'Conversation not found' ? 404 : 400, { error: error.message });
    }
  };
  const server = createServer((req, res) => { void route(req, res); });
  const web = runtime.plugins.ctx.inject(['harnessAgent', 'harnessSessions'], (ctx) => {
    ctx.provide('harnessWeb', server);
    ctx.effect(() => () => new Promise<void>((done) => server.close(() => done())));
  });
  await web.await();
  let closing: Promise<void>;
  return {
    server, runtime, token,
    async listen(port = runtime.settings.port) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return (server.address() as AddressInfo).port;
    },
    close() {
      closing ??= Promise.all([
        web.dispose(), runtime.stop()
      ]).then(() => {});
      return closing;
    }
  };
}
