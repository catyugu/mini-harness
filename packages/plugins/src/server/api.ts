import { addAbortListener } from 'node:events';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { protectLocal } from '@mini-harness/platform/local-secret';
import { readJson, writeJson } from '@mini-harness/platform/json';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from 'cordis';
import { assertOutsideMountTransaction, pluginRequestSignal, withPluginRequest } from '@mini-harness/kernel/mutation-api';
import type { PluginScope, ScopeKey } from '@mini-harness/kernel/scopes';
import type { ServiceMap } from '@mini-harness/kernel/services';
import type { PluginApi } from '@mini-harness/plugin-api/descriptor';
import type { DiscoveredPlugin } from './descriptor.js';
import { bindContributionSource, contribute } from '@mini-harness/kernel/contributions';
import { pluginInvocation } from './invocation.js';

export interface PluginLifetime {
  scope: PluginScope;
  scopeKey?: ScopeKey;
  lifetime: AbortSignal;
  trusted: boolean;
  address(key: ScopeKey): readonly ScopeKey[];
  prepare(key: ScopeKey, signal: AbortSignal): Promise<void>;
  scopedService<Name extends keyof ServiceMap & string>(key: ScopeKey, name: Name): NonNullable<ServiceMap[Name]>;
  dataRoot: string;
  invalidate(): void;
  registerScopeRequest?(name: string, handler: (input: unknown, signal: AbortSignal) => Promise<unknown>): () => void;
  readConfig?(): Record<string, unknown>;
  subscribeConfig?(listener: () => void): () => void;
  writeConfig?(patch: Record<string, unknown>, check: () => void): Promise<void>;
  routes?: Context['harnessRoutes'];
  upgrade?(path: string, handler: import('@mini-harness/transport/routes').UpgradeHandler): () => Promise<void>;
}

export function createPluginApi(ctx: Context, { id, descriptor, config }: { id: string; descriptor: DiscoveredPlugin; config?: Record<string, unknown> }, state: PluginLifetime) {
  const { scope, scopeKey, lifetime } = state;
  const sessionKey = (id: string): ScopeKey => `session:${id}`;
  const address = (id: string) => state.address(sessionKey(id));
  let currentConfig = Object.freeze(structuredClone(config ?? {}));
  let installed = false;
  let applyingConfig = false;
  let applyConfig: Parameters<PluginApi['onConfigChange']>[0] | undefined;
  const inScope = (sessionId: string) => !scopeKey || address(sessionId).includes(scopeKey);
  const assertVisible = (id: string) => {
    lifetime.throwIfAborted();
    if (!address(id).length || !inScope(id)) throw new Error('Conversation outside plugin scope');
  };
  const instanceId = scopeKey ? scopeKey + '/' + id : id;
  const invocation = pluginInvocation(lifetime, instanceId);
  const network = new Set<() => Promise<void>>();
  function registerNetwork(register: () => () => Promise<void>) {
    return ctx.effect(() => {
      const close = register();
      let closing: Promise<void> | undefined;
      const release = () => closing ??= close();
      network.add(release);
      return async () => { await release(); network.delete(release); };
    });
  }
  const { run } = invocation;
  const source = bindContributionSource({
    context: ctx, pluginId: id, instanceId, scopeKey, signal: lifetime, run,
    visible: (sessionId: string) => !lifetime.aborted && inScope(sessionId),
    depth: (sessionId: string) => scopeKey ? address(sessionId).indexOf(scopeKey) + 1 : 0,
    service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]> {
      if (!descriptor.inject?.includes(name)) throw new Error('Contribution dependency is not declared by ' + id + ': ' + name);
      const value = ctx.get(name) as ServiceMap[Name] | undefined;
      if (value == null) throw new Error('Contribution dependency is unavailable to ' + id + ': ' + name);
      return value;
    }
  }, state.trusted);
  const instance = scopeKey ? createHash('sha256').update(scopeKey).digest('hex') : 'application';
  const windows = process.platform === 'win32';
  const storagePath = (name: string, privateValue = false) => {
    lifetime.throwIfAborted();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid private data name');
    const root = join(state.dataRoot, id, instance);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (relative(root, realpathSync(root))) throw new Error('Plugin data directory was redirected');
    const file = join(root, (privateValue ? '.' : '') + name + '.json');
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.nlink !== 1 || (privateValue && !windows &&
        (entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0)))) throw new Error('Invalid plugin data file');
    return file;
  };
  function readValue<T>(key: string): T {
    lifetime.throwIfAborted();
    const values = installed ? state.readConfig?.() ?? currentConfig : currentConfig;
    return (Object.hasOwn(values, key) ? structuredClone(values[key]) : undefined) as T;
  }
  async function write(values: Record<string, unknown>) {
    const request = pluginRequestSignal();
    const signal = request ? AbortSignal.any([lifetime, request]) : lifetime;
    const check = () => {
      signal.throwIfAborted();
      if (!installed || applyingConfig) throw new Error('Plugin settings cannot be written during setup or configuration callbacks');
    };
    check();
    if (!state.writeConfig || descriptor.configChanges !== 'live')
      throw new Error('Server plugin configuration writes require live configuration');
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      listener = addAbortListener(signal, () => reject(signal.reason));
    });
    try { await Promise.race([state.writeConfig(structuredClone(values), check), aborted]); }
    finally { listener?.[Symbol.dispose](); }
  }
  const api: PluginApi = {
    scope: Object.freeze({ ...scope }), signal: lifetime,
    get config() { return currentConfig; },
    configuration: {
      get: readValue,
      set: (key, value) => write({ [key]: value }),
      patch: write,
      subscribe<T>(key: string, listener: (value: T) => void) {
        let previous = readValue<T>(key);
        return ctx.effect(() => state.subscribeConfig?.(() => {
          if (lifetime.aborted) return;
          const next = readValue<T>(key);
          if (isDeepStrictEqual(previous, next)) return;
          previous = structuredClone(next);
          listener(next);
        }) ?? (() => {}));
      }
    },
    onConfigChange(apply) {
      lifetime.throwIfAborted();
      if (descriptor.configChanges !== 'live' || applyConfig) throw new Error('Expected one declared configuration handler');
      applyConfig = apply;
    },
    contribute: (point, ...args) => contribute(source, point, args),
    invalidate() { lifetime.throwIfAborted(); state.invalidate(); },
    storage: {
      read: (name, fallback) => readJson(storagePath(name), fallback),
      write: (name, value) => writeJson(storagePath(name), value),
      remove: (name) => rmSync(storagePath(name), { force: true })
    },
    secrets: {
      read(name) {
        const value = readJson<unknown>(storagePath(name, true), undefined);
        if (value === undefined) return;
        if (typeof value !== 'string') throw new Error('Invalid protected plugin data');
        return windows ? protectLocal('Unprotect', Buffer.from(value, 'base64')).toString('utf8') : value;
      },
      write(name, value) {
        if (typeof value !== 'string' || Buffer.byteLength(value) > 16384) throw new Error('Invalid protected plugin data');
        writeJson(storagePath(name, true), windows ? protectLocal('Protect', Buffer.from(value)).toString('base64') : value);
      },
      remove: (name) => rmSync(storagePath(name, true), { force: true })
    },
    scopedService(id, name) {
      assertOutsideMountTransaction();
      assertVisible(id);
      if (!descriptor.inject?.includes(name)) throw new Error('Required service is not declared by ' + descriptor.id + ': ' + name);
      return state.scopedService(sessionKey(id), name);
    },
    prepareSession(id, signal) {
      assertVisible(id);
      return state.prepare(sessionKey(id), signal ? AbortSignal.any([lifetime, signal]) : lifetime);
    },
    registerRoute(method, path, handler) {
      if (scopeKey || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
          !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Invalid plugin route');
      const routes = state.routes;
      if (!routes) throw new Error('HTTP routes are unavailable');
      return registerNetwork(() => routes.register(method, '/api/extensions/' + id + path, (request) =>
        withPluginRequest(request.signal, () => handler(request))));
    },
    registerScopeRequest(name, handler) {
      const register = state.registerScopeRequest;
      if (!register || !/^[a-z][a-z0-9-]{0,63}$/.test(name) || typeof handler !== 'function')
        throw new Error('Invalid scoped plugin request');
      return ctx.effect(() => register(name, (input, signal) =>
        run('scoped request ' + name, (request) => withPluginRequest(request, () => handler(input, request)), signal)));
    },
    registerUpgrade(path, handler) {
      if (scopeKey || !state.upgrade || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path))
        throw new Error('Invalid WebSocket route');
      lifetime.throwIfAborted();
      const register = state.upgrade;
      return registerNetwork(() => register('/api/extensions/' + id + path, (request, socket, head, signal) =>
        withPluginRequest(signal, () => handler(request, socket, head, signal))));
    }
  };
  return { api, async drain() {
    await Promise.all([invocation.drain(), ...[...network].map((release) => release())]);
  }, async updateConfig(next: Record<string, unknown>) {
    const config = Object.freeze(structuredClone(next));
    applyingConfig = true;
    try {
      await applyConfig?.(config);
      currentConfig = config;
    } finally { applyingConfig = false; }
  }, checkPublications() {
    const registered = new Set([...ctx.fiber.provisions].map(({ name }) => name));
    const declared = descriptor.provides ?? [];
    const unexpected = [...registered].find((name) => !declared.includes(name));
    if (unexpected) throw new Error('Undeclared service: ' + unexpected);
    if (declared.some((name) => !registered.has(name)))
      throw new Error('Plugin did not publish all declared services: ' + id);
    installed = true;
  } };
}
