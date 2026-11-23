import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { PluginApi } from 'mini-harness/plugin';
import QRCode from 'qrcode';

interface Device { id: string; expiresAt: number; digest: string }
interface Options { port: number; origin: string; lifetimeMinutes: number }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const expiry = 2 * 60 * 1000;

function config(value: Readonly<Record<string, unknown>>): Options {
  const port = Number(value.port);
  const address = String(value.publicOrigin);
  const origin = address ? new URL(address) : new URL('http://127.0.0.1:' + port);
  if (address && (origin.protocol !== 'https:' || origin.origin !== address))
    throw new Error('Use an HTTPS origin without a path');
  return { port, origin: origin.origin, lifetimeMinutes: Number(value.lifetimeMinutes) };
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readCode(request: IncomingMessage) {
  let body = '';
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 2048) return;
  }
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === 'object' && 'code' in value && typeof value.code === 'string') return value.code;
  } catch { return; }
}

function pairingPage(response: ServerResponse) {
  const nonce = randomBytes(18).toString('base64');
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; connect-src 'self'; script-src 'nonce-" + nonce + "'; frame-ancestors 'none'; base-uri 'none'",
    'Referrer-Policy': 'no-referrer' });
  response.end('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Pair with mini-harness</title><main><h1>Pair with mini-harness</h1><p id="status" role="status">Pairing…</p></main>' +
    '<script nonce="' + nonce + '">' +
    'const code = new URLSearchParams(location.hash.slice(1)).get("code"); history.replaceState(null,"","/pair");' +
    'fetch("/pair",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})})' +
    '.then(r=>{if(!r.ok) throw Error();return r.json()})' +
    '.then(({token})=>{location.replace("/#token="+encodeURIComponent(token))})' +
    '.catch(()=>{document.getElementById("status").textContent="Pairing expired. Request a new link in mini-harness."});</script></html>');
}

export default async function setup(_ctx: unknown, api: PluginApi) {
  const network = api.service('harnessNetwork');
  let options = config(api.config);
  let devices = api.storage.read<Device[]>('devices', []).filter(({ expiresAt }) => expiresAt > Date.now());
  const viewers = new Map<string, { controller: AbortController; expiration: ReturnType<typeof setTimeout> }>();
  let pairing: { digest: string; expiresAt: number } | undefined;
  let listener: Server | undefined;
  const persist = (next: Device[]) => {
    api.storage.write('devices', next);
    devices = next;
    api.invalidate();
  };
  function disconnect(id: string) {
    const active = viewers.get(id);
    if (!active) return;
    viewers.delete(id);
    clearTimeout(active.expiration);
    active.controller.abort();
  }
  function lease(device: Device) {
    let active = viewers.get(device.id);
    if (!active) {
      const controller = new AbortController();
      const expiration = setTimeout(() => { disconnect(device.id); api.invalidate(); }, device.expiresAt - Date.now());
      expiration.unref();
      active = { controller, expiration };
      viewers.set(device.id, active);
    }
    return active.controller.signal;
  }

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const method = request.method;
    const path = new URL(request.url ?? '/', options.origin).pathname;
    if (request.headers.host !== new URL(options.origin).host ||
      (request.headers.origin && request.headers.origin !== options.origin)) return json(response, 403, { error: 'Origin not allowed' });
    if (path === '/pair' && method === 'GET') return pairingPage(response);
    if (path === '/pair' && method === 'POST') {
      if (request.headers.origin !== options.origin) return json(response, 403, { error: 'Origin not allowed' });
      const code = await readCode(request);
      if (!code || !pairing || pairing.expiresAt <= Date.now() || pairing.digest !== digest(code))
        return json(response, 401, { error: 'Invalid or expired pairing' });
      pairing = undefined;
      const active = devices.filter((device) => device.expiresAt > Date.now());
      if (active.length >= 16) return json(response, 409, { error: 'Revoke a device before pairing another' });
      const token = randomBytes(32).toString('hex');
      const device = { id: randomUUID(), digest: digest(token), expiresAt: Date.now() + options.lifetimeMinutes * 60000 };
      persist([...active, device]);
      lease(device);
      response.setHeader('Set-Cookie', 'mini-harness-remote=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' +
        options.lifetimeMinutes * 60 + (options.origin.startsWith('https:') ? '; Secure' : ''));
      return json(response, 201, { token });
    }
    const credential = path.startsWith('/api/') ? request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1] :
      request.headers.cookie?.split(/;\s*/).find((value) => value.startsWith('mini-harness-remote='))?.slice('mini-harness-remote='.length);
    const key = credential && digest(credential);
    const device = key && devices.find((entry) => entry.digest === key && entry.expiresAt > Date.now());
    if (!device) return json(response, 401, { error: 'Pair this device first' });
    await network.forward(request, response, { origin: options.origin, signal: lease(device) });
  }

  const close = (server: Server | undefined) => {
    server?.close();
    server?.closeAllConnections();
  };
  async function listen(port: number) {
    const candidate = createServer((request, response) => {
      void handle(request, response).catch(() => {
        if (response.headersSent) response.destroy();
        else json(response, 500, { error: 'The gateway could not complete the request' });
      });
    });
    candidate.requestTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      candidate.once('error', reject);
      candidate.listen(port, '127.0.0.1', () => { candidate.off('error', reject); resolve(); });
    });
    return candidate;
  }
  api.onDispose(() => {
    pairing = undefined;
    for (const id of viewers.keys()) disconnect(id);
    close(listener);
  });
  listener = await listen(options.port);
  api.onConfigChange(async (value) => {
    const next = config(value);
    if (next.port !== options.port) {
      const running = await listen(next.port);
      close(listener);
      listener = running;
    }
    if (next.origin !== options.origin) {
      pairing = undefined;
      for (const id of viewers.keys()) disconnect(id);
    }
    options = next;
  });
  api.registerRoute('GET', '/devices', () => ({
    origin: options.origin,
    devices: devices.filter(({ expiresAt }) => expiresAt > Date.now()).map(({ id, expiresAt }) => ({ id, expiresAt }))
  }));
  api.registerRoute('POST', '/pair', async () => {
    const code = randomBytes(24).toString('hex');
    const url = options.origin + '/pair#code=' + code;
    const qr = await QRCode.toString(url, { type: 'svg', width: 216 });
    api.signal.throwIfAborted();
    pairing = { digest: digest(code), expiresAt: Date.now() + expiry };
    return { url, qr };
  });
  api.registerRoute('DELETE', '/device', async ({ url }) => {
    const id = url.searchParams.get('id');
    persist(devices.filter((device) => device.id !== id));
    if (id) disconnect(id);
    return { ok: true };
  });
}
