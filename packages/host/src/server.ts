import { DomainError } from '@mini-harness/platform/errors';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Context } from 'mini-harness/cordis';
import type {} from '@mini-harness/transport/runtime';
import type {} from '@mini-harness/plugins/api-types';
import { errorStatus, HttpError, type GatewayRequest } from '@mini-harness/transport/routes';
import { json } from '@mini-harness/transport/http';

const FEATURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_DIR = join(FEATURE_DIR, 'ui-runtime', 'src', 'assets');
const assets = new Map([
  ['index.html', 'text/html'],
  ['startup.css', 'text/css'],
  ['logo.svg', 'image/svg+xml'],
  ['manifest.webmanifest', 'application/manifest+json'],
  ['icon-192.png', 'image/png'],
  ['icon-512.png', 'image/png'],
  ['favicon.ico', 'image/x-icon'],
]);

const browserSdk = 'packages/sdk/src/browser-plugin.js';
assets.set(browserSdk, 'text/javascript');
for (const owner of readdirSync(FEATURE_DIR, { withFileTypes: true })) {
  if (!owner.isDirectory()) continue;
  const source = join(FEATURE_DIR, owner.name, 'src');
  for (const directory of ['browser', 'shared']) {
    const root = join(source, directory);
    if (!existsSync(root)) continue;
    for (const file of readdirSync(root, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.js') || /\.(?:test|spec)\.js$/.test(file.name)) continue;
      const path = relative(FEATURE_DIR, join(file.parentPath, file.name)).split(sep).join('/');
      assets.set('packages/' + path, 'text/javascript');
    }
  }
}

const vendor = resolve(FEATURE_DIR, '../vendor');
for (const owner of readdirSync(vendor, { withFileTypes: true })) {
  if (!owner.isDirectory()) continue;
  const source = join(vendor, owner.name, 'src');
  for (const file of readdirSync(source, { recursive: true, withFileTypes: true })) {
    if (!file.isFile() || !file.name.endsWith('.js')) continue;
    const path = relative(vendor, join(file.parentPath, file.name)).split(sep).join('/');
    assets.set('vendor/' + path, 'text/javascript');
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
  if (
    !before?.isFile() ||
    before.nlink !== 1 ||
    before.size > 1024 * 1024 ||
    relative(path, realpathSync(path))
  )
    throw new HttpError('not_found', 'Not found');
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(fd);
    const after = lstatSync(path);
    if (
      !after.isFile() ||
      opened.ino !== after.ino ||
      opened.dev !== after.dev ||
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      relative(path, realpathSync(path))
    )
      throw new HttpError('not_found', 'Not found');
    return { fd, size: opened.size };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function remoteRoute(method: string | undefined, path: string) {
  if (method !== 'GET') return false;
  const basic = [
    '/api/bootstrap',
    '/api/changes',
    '/api/settings',
    '/api/providers',
    '/api/models',
    '/api/plugins',
    '/api/workspaces',
    '/api/sessions',
    '/api/sessions/search',
    '/api/approvals',
  ];
  return (
    basic.includes(path) ||
    /^\/api\/sessions\/[a-f0-9-]{36}(?:\/(?:runs|events|queue))?$/.test(path) ||
    /^\/api\/workspaces\/[a-f0-9]{32}\/(?:sessions|skills|files\/(?:tree|search|preview|changes|diff))$/.test(
      path,
    )
  );
}

export function webServer(ctx: Context, token: string, shutdown: () => void) {
  const routes = ctx.harnessRoutes;
  const upgrades = ctx.harnessUpgrades;
  const plugins = ctx.harnessPluginCatalog;
  ctx.provide('harnessNetwork', {
    async forward(req, res, access) {
      if (access.signal.aborted) {
        res.destroy();
        return;
      }
      const abort = () => {
        res.destroy();
      };
      access.signal.addEventListener('abort', abort, { once: true });
      res.once('close', () => access.signal.removeEventListener('abort', abort));
      await route(req, res, access);
    },
  });
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
        if (req.method !== 'GET' && req.method !== 'HEAD')
          return json(res, 405, { error: 'Method not allowed' });
        let requested: string;
        try {
          requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
        } catch {
          throw new HttpError('invalid_input', 'Invalid URL encoding');
        }
        const extension = plugins.browserAsset(pathname);
        const mime = extension?.mime ?? assets.get(requested);
        if (!mime) throw new HttpError('not_found', 'Not found');
        const path =
          extension?.path ??
          (requested.startsWith('packages/') || requested.startsWith('vendor/')
            ? join(FEATURE_DIR, '..', requested)
            : join(WEB_DIR, requested));
        const nonce = requested === 'index.html' ? randomBytes(18).toString('base64') : undefined;
        const csp =
          "default-src 'self'; script-src 'self'; style-src 'self'" +
          (nonce ? " 'nonce-" + nonce + "'" : '') +
          "; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
        if (nonce) {
          const page = readFileSync(path, 'utf8').replace('EDITOR_STYLE_NONCE', nonce);
          res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': Buffer.byteLength(page),
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': csp,
            'Referrer-Policy': 'no-referrer',
          });
          res.end(req.method === 'HEAD' ? undefined : page);
          return;
        }
        const opened = extension ? openAsset(path) : undefined;
        const size = opened?.size ?? statSync(path).size;
        const stream = req.method === 'HEAD' ? undefined : createReadStream(path, { fd: opened?.fd });
        if (stream) {
          stream.on('error', (error) => res.destroy(error));
          res.once('close', () => stream.destroy());
        } else if (opened) closeSync(opened.fd);
        res.writeHead(200, {
          'Content-Type': mime + '; charset=utf-8',
          'Content-Length': size,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': csp,
          'Referrer-Policy': 'no-referrer',
        });
        if (stream) stream.pipe(res);
        else res.end();
        return;
      }
      if (!remote && !authorize(req, token)) throw new HttpError('unauthorized', 'Unauthorized');
      if (
        !remote &&
        req.method !== 'GET' &&
        req.headers.origin &&
        req.headers.origin !== 'http://' + req.headers.host
      ) {
        throw new HttpError('forbidden', 'Origin not allowed');
      }
      if (pathname === '/api/shutdown' && req.method === 'POST') {
        res.once('finish', shutdown);
        return json(res, 202, { pid: process.pid });
      }
      const result = routes.dispatch(req, res, url);
      if (result) return await result;
      throw new HttpError('not_found', 'Not found');
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error instanceof DomainError) {
        if (res.headersSent) {
          res.end();
          return;
        }
        return json(res, errorStatus[error.code], { code: error.code, error: error.message });
      }
      ctx.logger.error(
        'HTTP %s failed: %s',
        req.method,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, 500, { code: 'internal_error', error: 'Internal server error' });
    }
  };
  const server = createServer((req, res) => {
    void route(req, res);
  });
  server.on('upgrade', (request, socket, head) => {
    const reject = (status: string) => socket.end('HTTP/1.1 ' + status + '\r\nConnection: close\r\n\r\n');
    if (!authorize(request, token)) {
      reject('401 Unauthorized');
      return;
    }
    if (request.headers.origin && request.headers.origin !== 'http://' + request.headers.host) {
      reject('403 Forbidden');
      return;
    }
    if (request.method !== 'GET' || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      reject('400 Bad Request');
      return;
    }
    if (!upgrades.dispatch((request.url ?? '').split('?')[0], request, socket, head)) reject('404 Not Found');
  });
  let closing: Promise<void>;
  return {
    server,
    token,
    async listen(port: number) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      });
      return (server.address() as AddressInfo).port;
    },
    close() {
      if (closing) return closing;
      const closed = new Promise<void>((done) => server.close(() => done()));
      upgrades.close();
      server.closeAllConnections();
      return (closing = closed);
    },
  };
}
