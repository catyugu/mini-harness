import { createServer } from 'node:http';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { getPaths } from './config.js';
import { json } from './transport/http.js';
import { MiniHarnessRuntime } from './application.js';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const FEATURE_DIR = resolve(WEB_DIR, '..', 'features');
const assets = new Map([
  ['index.html', 'text/html'],
  ['style.css', 'text/css'], ['logo.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
  ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['favicon.ico', 'image/x-icon']
]);

// Browser modules are built under dist/web. Local plugin source stays behind the authenticated API.
for (const entry of readdirSync(WEB_DIR, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    const path = relative(WEB_DIR, join(entry.parentPath, entry.name)).split(sep).join('/');
    // Co-located browser tests are compiled for Playwright but must never be web assets.
    if (path.split('/').includes('tests') || /\.(?:spec|test)\.js$/.test(path)) continue;
    assets.set(path, 'text/javascript');
  }
}

// Expose only browser entrypoints. Feature host and manifest JS never become public assets.
for (const entry of readdirSync(FEATURE_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name)) continue;
  const client = join(FEATURE_DIR, entry.name, 'client.js');
  try { if (statSync(client).isFile()) assets.set('features/' + entry.name + '/client.js', 'text/javascript'); }
  catch { /* Server-only capability. */ }
}

export function authorize(request: IncomingMessage, token: string) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const supplied = Buffer.from(auth.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function createMiniHarnessServer(paths: ReturnType<typeof getPaths>, options: { token?: string; shutdown?: () => void } = {}) {
  const runtime = new MiniHarnessRuntime(paths);
  const navigation = new AbortController();
  runtime.plugins.ctx.provide('harnessTransportSignal', navigation.signal);
  await runtime.start();
  const token = options.token ?? randomBytes(32).toString('hex');
  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
        const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        // Browser imports in root-level feature sources use ../web/ paths. Redirect to
        // canonical app-module URLs so modules have one identity across UI and plugins.
        if (requested.startsWith('web/') && assets.has(requested.slice(4))) {
          res.writeHead(307, { Location: '/' + requested.slice(4), 'Cache-Control': 'no-store' });
          return res.end();
        }
        const mime = assets.get(requested);
        if (!mime) return json(res, 404, { error: 'Not found' });
        const path = requested.startsWith('features/') ? join(FEATURE_DIR, requested.slice('features/'.length)) : join(WEB_DIR, requested);
        const size = statSync(path).size;
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8',
          'Content-Length': size, 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self' blob:; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'Referrer-Policy': 'no-referrer' });
        return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
      }
      if (!authorize(req, token)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).origin !== 'http://' + req.headers.host) {
        return json(res, 403, { error: 'Origin not allowed' });
      }
      if (pathname === '/api/status' && req.method === 'GET')
        return json(res, 200, { pid: process.pid });
      if (pathname === '/api/shutdown' && req.method === 'POST' && options.shutdown) {
        res.once('finish', options.shutdown);
        return json(res, 202, { pid: process.pid });
      }
      const result = runtime.plugins.ctx.harnessRoutes.dispatch(req, res, url);
      if (result) return await result;
      return json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, ['Conversation not found', 'Workspace not found'].includes(error.message) ? 404 :
        error.message === 'Conversation changed; refresh before editing' || error.message === 'Conversation is already running' ? 409 : 400,
        { error: error.message });
    }
  };
  const server = createServer((req, res) => { void route(req, res); });
  let closing: Promise<void>;
  return {
    server, get runtime() { return runtime; }, token,
    async listen(port = runtime.settings.port) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return (server.address() as AddressInfo).port;
    },
    close() {
      navigation.abort();
      closing ??= Promise.all([
        new Promise<void>((done) => server.close(() => done())), runtime.stop()
      ]).then(() => {});
      return closing;
    }
  };
}
