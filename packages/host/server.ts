import { DomainError } from '@mini-harness/platform/errors';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { closeSync, constants, createReadStream, fstatSync, openSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Paths } from '@mini-harness/platform/runtime-paths';
import { Upgrades } from './upgrade.js';
import { errorStatus, HttpError, type GatewayRequest } from '@mini-harness/transport/routes';
import { json } from '@mini-harness/transport/http';
import { MiniHarnessRuntime } from './application.js';

const FEATURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = join(FEATURE_DIR, 'ui-runtime', 'assets');
const assets = new Map([
  ['index.html', 'text/html'],
  ['theme.css', 'text/css'], ['logo.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
  ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['favicon.ico', 'image/x-icon']
]);

// The browser SDK keeps its public URL independently of its source package.
const browserSdk = 'packages/ui-runtime/plugin-sdk.js';
assets.set(browserSdk, 'text/javascript');
for (const path of [
  'ui-runtime/boot.js', 'ui-runtime/frontend.js', 'ui-runtime/http.js',
  'ui-runtime/plugin-loader.js', 'ui-runtime/projections.js', 'ui-runtime/remote-store.js',
  'ui-runtime/vendor/cordis.js', 'ui-runtime/vendor/cosmokit.js',
  'ui-primitives/icons.js', 'ui-primitives/markdown.js', 'ui-primitives/primitives.js',
  'ui-primitives/vendor/marked.js', 'ui-primitives/vendor/purify.js',
  'ui-layout/layout.js', 'ui-layout/right-tabs.js', 'ui-slots/registry.js'
]) assets.set('packages/' + path, 'text/javascript');

// Packages opt in to browser delivery through their entrypoints or browser-only files.
for (const owner of readdirSync(FEATURE_DIR, { withFileTypes: true })) {
  if (!owner.isDirectory() || !/^[a-z][a-z0-9-]{0,63}$/.test(owner.name)) continue;
  const root = join(FEATURE_DIR, owner.name);
  const include = (file: string) => {
    const path = relative(FEATURE_DIR, file).split(sep).join('/');
    if (path.split('/').includes('tests') || /\.(?:test|spec)\.js$/.test(path)) return;
    assets.set('packages/' + path, 'text/javascript');
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name === 'client.js' || entry.name === 'browser.js' || entry.name.endsWith('.browser.js')))
      include(join(root, entry.name));
    if (!entry.isDirectory() || entry.name !== 'browser') continue;
    for (const file of readdirSync(join(root, entry.name), { recursive: true, withFileTypes: true }))
      if (file.isFile() && file.name.endsWith('.js')) include(join(file.parentPath, file.name));
  }
}

export function authorize(request: IncomingMessage, token: string) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const supplied = Buffer.from(auth.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function openAsset(path: string) {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before?.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || relative(path, realpathSync(path)))
    throw new HttpError('not_found', 'Not found');
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(path);
    if (!after.isFile() || opened.ino !== after.ino || opened.dev !== after.dev ||
        opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size ||
        relative(path, realpathSync(path))) throw new HttpError('not_found', 'Not found');
    return { fd, size: opened.size };
  } catch (error) { closeSync(fd); throw error; }
}

function remoteRoute(method: string | undefined, path: string) {
  if (method !== 'GET') return false;
  const basic = ['/api/bootstrap', '/api/changes', '/api/settings', '/api/providers', '/api/models', '/api/plugins',
    '/api/workspaces', '/api/sessions', '/api/sessions/search', '/api/approvals'];
  return basic.includes(path) ||
    /^\/api\/sessions\/[a-f0-9-]{36}(?:\/(?:runs|events|queue))?$/.test(path) ||
    /^\/api\/workspaces\/[a-f0-9]{32}\/(?:sessions|skills|files\/(?:tree|search|preview|changes|diff))$/.test(path);
}

export async function createMiniHarnessServer(paths: Paths, options: { token?: string; shutdown?: () => void } = {}) {
  const upgrades = new Upgrades();
  const runtime = new MiniHarnessRuntime(paths, {
    async forward(req, res, access) {
      if (access.signal.aborted) { res.destroy(); return; }
      const abort = () => { res.destroy(); };
      access.signal.addEventListener('abort', abort, { once: true });
      res.once('close', () => access.signal.removeEventListener('abort', abort));
      await route(req, res, access);
    }
  }, (path, handler) => upgrades.register(path, handler));
  const navigation = new AbortController();
  runtime.plugins.ctx.provide('harnessTransportSignal', navigation.signal);
  const token = options.token ?? randomBytes(32).toString('hex');
  const route = async (req: IncomingMessage, res: ServerResponse, remote?: GatewayRequest): Promise<void> => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const pathname = url.pathname;
      if (remote) {
        const origin = new URL(remote.origin);
        if (req.headers.host !== origin.host || (req.headers.origin && req.headers.origin !== origin.origin))
          throw new HttpError('forbidden', 'Origin not allowed');
        if (pathname.startsWith('/api/') && !remoteRoute(req.method, pathname))
          throw new HttpError('forbidden', 'This action requires local access');
      }
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
        let requested: string;
        try { requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1)); }
        catch { throw new HttpError('invalid_input', 'Invalid URL encoding'); }
        const extension = runtime.plugins.browserAsset(pathname);
        const mime = extension?.mime ?? assets.get(requested);
        if (!mime) throw new HttpError('not_found', 'Not found');
        const asset = requested === browserSdk ? 'packages/sdk/browser-plugin.js' : requested;
        const path = extension?.path ?? (asset.startsWith('packages/') ? join(FEATURE_DIR, asset.slice('packages/'.length)) : join(WEB_DIR, asset));
        const opened = extension ? openAsset(path) : undefined;
        const size = opened?.size ?? statSync(path).size;
        const stream = req.method === 'HEAD' ? undefined : createReadStream(path, { fd: opened?.fd });
        if (stream) {
          stream.on('error', (error) => res.destroy(error));
          res.once('close', () => stream.destroy());
        } else if (opened) closeSync(opened.fd);
        res.writeHead(200, { 'Content-Type': mime + '; charset=utf-8',
          'Content-Length': size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'Referrer-Policy': 'no-referrer' });
        if (stream) stream.pipe(res);
        else res.end();
        return;
      }
      if (!remote && !authorize(req, token)) throw new HttpError('unauthorized', 'Unauthorized');
      if (!remote && req.method !== 'GET' && req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) {
        throw new HttpError('forbidden', 'Origin not allowed');
      }
      if (pathname === '/api/status' && req.method === 'GET')
        return json(res, 200, { pid: process.pid, sessionDiagnostics: runtime.registry.diagnostics() });
      if (pathname === '/api/shutdown' && req.method === 'POST' && options.shutdown) {
        res.once('finish', options.shutdown);
        return json(res, 202, { pid: process.pid });
      }
      const result = runtime.plugins.ctx.harnessRoutes.dispatch(req, res, url);
      if (result) return await result;
      throw new HttpError('not_found', 'Not found');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof DomainError) {
        if (res.headersSent) { res.end(); return; }
        return json(res, errorStatus[error.code], { code: error.code, error: error.message });
      }
      runtime.plugins.ctx.logger.error('HTTP %s failed: %s', req.method, error instanceof Error ? error.stack ?? error.message : String(error));
      if (res.headersSent) { res.end(); return; }
      json(res, 500, { code: 'internal_error', error: 'Internal server error' });
    }
  };
  await runtime.start();
  const server = createServer((req, res) => { void route(req, res); });
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: string) => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n');
    if (!authorize(request, token)) { reject('401 Unauthorized'); return; }
    if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) { reject('403 Forbidden'); return; }
    if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') { reject('400 Bad Request'); return; }
    if (!upgrades.dispatch((request.url ?? '').split('?')[0], request, socket, head)) reject('404 Not Found');
  });
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
