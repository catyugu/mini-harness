import { createServer } from 'node:http';
import { createReadStream, readdirSync, statSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getPaths, ensurePaths, readJson, writeJson } from './config.js';
import { containsPath } from './workspace.js';
import { json, requestBody } from './http.js';
import { providerSettings, saveProvider, saveProviderCredential } from './provider-settings.js';
import { installPlugin, uninstallPlugin, frontendSource } from './plugin-files.js';
import { supportsIsolation } from './sandbox.js';
import { MiniHarnessRuntime } from './agent.js';
import { sessionRoutes } from './session-routes.js';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'web');
const assets = new Map([
  ['index.html', 'text/html'],
  ['style.css', 'text/css'], ['logo.svg', 'image/svg+xml'], ['manifest.webmanifest', 'application/manifest+json'],
  ['icon-192.png', 'image/png'], ['icon-512.png', 'image/png'], ['favicon.ico', 'image/x-icon']
]);

// Browser modules are built under dist/web. Local plugin source stays behind the authenticated API.
for (const entry of readdirSync(WEB_DIR, { recursive: true, withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.js')) {
    const path = relative(WEB_DIR, join(entry.parentPath, entry.name)).split(sep).join('/');
    assets.set(path, 'text/javascript');
  }
}

export function authorize(request: IncomingMessage, token: string) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  const expected = Buffer.from(token);
  const supplied = Buffer.from(auth.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function createMiniHarnessServer(paths: ReturnType<typeof getPaths>, options: { token?: string; shutdown?: () => void } = {}) {
  let runtime = new MiniHarnessRuntime(paths);
  let switching = false;
  let configuring = false;
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
          'Content-Security-Policy': "default-src 'self'; script-src 'self' blob:; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'Referrer-Policy': 'no-referrer' });
        return req.method === 'HEAD' ? res.end() : createReadStream(path).pipe(res);
      }
      if (!authorize(req, token)) return json(res, 401, { error: 'Unauthorized' });
      if (req.method !== 'GET' && req.headers.origin && new URL(req.headers.origin).origin !== 'http://' + req.headers.host) {
        return json(res, 403, { error: 'Origin not allowed' });
      }
      if (switching) return json(res, 409, { error: 'Workspace is switching; reload when it finishes' });
      if (req.headers['x-workspace'] && decodeURIComponent(String(req.headers['x-workspace'])) !== runtime.paths.cwd)
        return json(res, 409, { error: 'Workspace changed in another tab. Reload this page to continue.' });
      const workspacesFile = join(paths.home, 'workspaces.json');
      const workspaces = () => [...new Set([runtime.paths.cwd, ...readJson<string[]>(workspacesFile, [])])].slice(0, 30);
      if (pathname === '/api/workspaces' && req.method === 'GET') return json(res, 200, { current: runtime.paths.cwd, paths: workspaces() });
      if (pathname === '/api/workspaces' && req.method === 'POST') {
        if (configuring || runtime.hasActiveWork) throw new Error('Stop active conversations before switching workspace');
        const input = await requestBody(req);
        if (typeof input.path !== 'string' || !isAbsolute(input.path)) throw new Error('Enter an absolute workspace path');
        const target = realpathSync(input.path);
        if (!statSync(target).isDirectory() || containsPath(paths.home, target)) throw new Error('Select a workspace directory outside mini-harness configuration');
        const known = [...new Set([target, ...workspaces()])].slice(0, 30);
        if (switching || configuring || runtime.hasActiveWork) throw new Error('Stop active conversations before switching workspace');
        const previous = runtime.paths;
        switching = true;
        try {
          await runtime.stop();
          const nextPaths = getPaths(target, { MINI_HARNESS_HOME: paths.home }); ensurePaths(nextPaths);
          runtime = new MiniHarnessRuntime(nextPaths);
          await runtime.start();
          writeJson(workspacesFile, known);
        } catch (error) {
          await runtime.stop().catch(() => {});
          runtime = new MiniHarnessRuntime(previous); await runtime.start();
          throw error;
        } finally { switching = false; }
        return json(res, 200, { current: runtime.paths.cwd, paths: known });
      }
      if (pathname === '/api/providers' && req.method === 'GET') return json(res, 200, providerSettings(runtime));
      if (pathname === '/api/providers' && ['PUT', 'DELETE'].includes(req.method)) {
        if (configuring) throw new Error('Configuration is already changing');
        configuring = true;
        try { return json(res, 200, await saveProvider(runtime, await requestBody(req), req.method === 'DELETE')); }
        finally { configuring = false; }
      }
      if (pathname === '/api/plugins/install' && req.method === 'POST') return json(res, 201, installPlugin(runtime, await requestBody(req, 2 * 1024 * 1024)));
      const plugin = /^\/api\/plugins\/([a-z][a-z0-9-]{0,63})(?:\/(web))?$/.exec(pathname);
      if (plugin && req.method === 'DELETE') return json(res, 200, await uninstallPlugin(runtime, plugin[1]));
      if (plugin?.[2] === 'web' && req.method === 'GET') return json(res, 200, { source: frontendSource(runtime, plugin[1]), config: runtime.plugins.configuration(plugin[1]) });
      if (!configuring) {
        const extension = runtime.plugins.ctx.harnessRoutes.dispatch(req, res, url);
        if (extension) return await extension;
      }
      if (pathname === '/api/status' && req.method === 'GET') return json(res, 200, { pid: process.pid });
      if (pathname === '/api/shutdown' && req.method === 'POST' && options.shutdown) {
        res.once('finish', options.shutdown);
        return json(res, 202, { pid: process.pid });
      }
      if (pathname === '/api/bootstrap' && req.method === 'GET')
        return json(res, 200, { settings: runtime.settings, sessions: runtime.registry.list().map((item) => ({ ...item, run: runtime.runInfo(item.id) })), models: runtime.availableModels(), plugins: runtime.plugins.metadata(), workspace: runtime.paths.cwd, isolation, providers: providerSettings(runtime) });
      if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/'))
        return await sessionRoutes(runtime, req, res, url, () => configuring || switching || req.headers['x-workspace'] &&
          decodeURIComponent(String(req.headers['x-workspace'])) !== runtime.paths.cwd);
      if (pathname === '/api/settings' && req.method === 'PATCH') {
        if (configuring) throw new Error('Configuration is already changing');
        configuring = true;
        try { return json(res, 200, await runtime.updateSettings(await requestBody(req))); }
        finally { configuring = false; }
      }
      if (pathname === '/api/credentials' && ['POST', 'DELETE'].includes(req.method)) {
        if (configuring) throw new Error('Configuration is already changing');
        configuring = true;
        try {
          const input = await requestBody(req);
          if (typeof input?.provider !== 'string' || !/^[a-z0-9-]+$/.test(input.provider))
            return json(res, 400, { error: 'Invalid provider' });
          if (!runtime.models.getProvider(input.provider)) return json(res, 400, { error: 'Unknown provider' });
          if (req.method === 'DELETE') {
            if (runtime.hasActiveWork) throw new Error('Stop active conversations before removing credentials');
            await runtime.models.logout(input.provider);
          } else {
            if (typeof input.key !== 'string' || !input.key.trim()) return json(res, 400, { error: 'Invalid credential' });
            await saveProviderCredential(runtime, input.provider, input.key.trim());
          }
          return json(res, 200, { ok: true, persisted: true, models: runtime.availableModels(), status: runtime.models.getProviderAuthStatus(input.provider) });
        } finally { configuring = false; }
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
      closing ??= Promise.all([
        new Promise<void>((done) => server.close(() => done())), runtime.stop()
      ]).then(() => {});
      return closing;
    }
  };
}
