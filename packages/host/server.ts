import { createServer } from 'node:http';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Paths } from '@mini-harness/contracts/config';
import { json } from '@mini-harness/transport/http';
import { MiniHarnessRuntime } from './application.js';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const FEATURE_DIR = resolve(WEB_DIR, '..');
const assets = new Map([
  ['index.html', 'text/html'],
  ['theme.css', 'text/css'], ['logo.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
  ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['favicon.ico', 'image/x-icon']
]);

// Browser modules are built under dist/packages/web. Local plugin source stays behind the authenticated API.
for (const entry of readdirSync(WEB_DIR, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    const path = relative(WEB_DIR, join(entry.parentPath, entry.name)).split(sep).join('/');
    // Co-located browser tests are compiled for Playwright but must never be web assets.
    if (path.split('/').includes('tests') || /\.(?:spec|test)\.js$/.test(path)) continue;
    assets.set('packages/web/' + path, 'text/javascript');
  }
}

// Only client modules from UI foundations may be served.
for (const name of ['ui-runtime', 'ui-slots', 'ui-theme', 'ui-primitives', 'ui-layout']) {
  const root = join(FEATURE_DIR, name);
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const path = relative(FEATURE_DIR, join(entry.parentPath, entry.name)).split(sep).join('/');
    if (path.split('/').includes('tests') || /\.(?:spec|test)\.js$/.test(path) || entry.name === 'manifest.js') continue;
    assets.set('packages/' + path, 'text/javascript');
  }
}

// Expose only browser entrypoints. Feature host and manifest JS never become public assets.
for (const entry of readdirSync(FEATURE_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.name)) continue;
  const client = join(FEATURE_DIR, entry.name, 'client.js');
  try { if (statSync(client).isFile()) assets.set('packages/' + entry.name + '/client.js', 'text/javascript'); }
  catch { /* Server-only capability. */ }
  const browserEntry = join(FEATURE_DIR, entry.name, 'browser.js');
  try { if (statSync(browserEntry).isFile()) assets.set('packages/' + entry.name + '/browser.js', 'text/javascript'); }
  catch { /* No standalone browser entry. */ }
  const browserDir = join(FEATURE_DIR, entry.name, 'browser');
  try {
    if (!statSync(browserDir).isDirectory()) continue;
    for (const file of readdirSync(browserDir, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.js')) continue;
      const path = relative(FEATURE_DIR, join(file.parentPath, file.name)).split(sep).join('/');
      if (path.split('/').includes('tests') || /\\.(?:test|spec)\\.js$/.test(path)) continue;
      assets.set('packages/' + path, 'text/javascript');
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export function authorize(request: IncomingMessage, token: string) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const supplied = Buffer.from(auth.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function createMiniHarnessServer(paths: Paths, options: { token?: string; shutdown?: () => void } = {}) {
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
        const mime = assets.get(requested);
        if (!mime) return json(res, 404, { error: 'Not found' });
        const path = requested.startsWith('packages/') ? join(FEATURE_DIR, requested.slice('packages/'.length)) : join(WEB_DIR, requested);
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
      json(res, ['Conversation not found', 'Workspace not found'].includes((error instanceof Error ? error.message : String(error))) ? 404 :
        (error instanceof Error ? error.message : String(error)) === 'Conversation changed; refresh before editing' || (error instanceof Error ? error.message : String(error)) === 'Conversation is already running' ? 409 : 400,
        { error: (error instanceof Error ? error.message : String(error)) });
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
