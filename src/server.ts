import { createServer } from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { getPaths } from './config.js';
import { writeJson, readJson } from './config.js';
import { supportsIsolation } from './sandbox.js';
import { MiniHarnessRuntime } from './agent.js';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const assets = new Map([
  ['index.html', 'text/html'], ['app.js', 'text/javascript'], ['markdown.js', 'text/javascript'],
  ['vendor/marked.js', 'text/javascript'], ['vendor/purify.js', 'text/javascript'],
  ['style.css', 'text/css'], ['logo.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json']
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
        return json(res, 200, { settings: runtime.settings, sessions: runtime.registry.list(), models: runtime.availableModels(), plugins: runtime.plugins.metadata(), workspace: paths.cwd, isolation });
      if (pathname === '/api/sessions' && req.method === 'GET') return json(res, 200, runtime.registry.list());
      if (pathname === '/api/sessions' && req.method === 'POST') return json(res, 201, runtime.registry.create());
      const match = /^\/api\/sessions\/([a-f0-9-]{36})(?:\/(messages|cancel))?$/.exec(pathname);
      if (match) {
        const id = match[1];
        if (!runtime.registry.get(id)) return json(res, 404, { error: 'Conversation not found' });
        if (!match[2] && req.method === 'GET') return json(res, 200, await runtime.getConversation(id));
        if (match[2] === 'cancel' && req.method === 'POST') return json(res, 200, { cancelled: runtime.cancel(id) });
        if (match[2] === 'messages' && req.method === 'POST') {
          const input = await requestBody(req);
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          const controller = new AbortController();
          res.once('close', () => {
            if (!res.writableEnded) controller.abort();
          });
          const emit = (event: unknown) => {
            if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n');
          };
          try { await runtime.send(id, input.message, emit, { signal: controller.signal }); }
          catch (error) { emit({ type: 'error', error: error instanceof Error ? error.message : String(error) }); }
          if (!res.destroyed) res.end();
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
        const credentialsPath = join(paths.home, 'auth.json');
        const stored = readJson(credentialsPath, {});
        stored[input.provider] = { type: 'api_key', key: input.key.trim() };
        writeJson(credentialsPath, stored);
        await runtime.models.setRuntimeApiKey(input.provider, input.key.trim());
        return json(res, 200, { ok: true, persisted: true });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error.message === 'Conversation not found' ? 404 : 400, { error: error.message });
    }
  };
  const server = createServer((req, res) => { void route(req, res); });
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
        new Promise<void>((done) => server.close(() => done())),
        runtime.stop()
      ]).then(() => {});
      return closing;
    }
  };
}
