import { addAbortListener } from 'node:events';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { protectLocal } from '@mini-harness/platform/local-secret';
import { readJson, writeJson } from '@mini-harness/platform/config';
import { isDeepStrictEqual } from 'node:util';
import type { Context } from 'cordis';
import type { PluginScope } from '@mini-harness/contracts/capabilities';
import type { ServiceMap } from '@mini-harness/contracts/plugin-sdk';
import type { PluginApi, PluginDescriptor, SessionRecords } from '@mini-harness/contracts/plugins';
import { executionHooks } from './execution-hooks.js';

export interface PluginLifetime {
  scope: PluginScope;
  scopeKey?: string;
  lifetime: AbortSignal;
  address(id: string): readonly string[];
  records(id: string): SessionRecords;
  dataRoot: string;
  invalidate(): void;
  readConfig?(): Record<string, unknown>;
  subscribeConfig?(listener: () => void): () => void;
  writeConfig?(patch: Record<string, unknown>, check: () => void): Promise<void>;
  routes?: Context['harnessRoutes'];
  upgrade?(path: string, handler: import('@mini-harness/contracts/routes').UpgradeHandler): () => void;
}

export function createPluginApi(ctx: Context, { id, descriptor, config }: { id: string; descriptor: PluginDescriptor; config?: Record<string, unknown> }, state: PluginLifetime) {
  const { scope, scopeKey, lifetime, records, address } = state;
  const provided = new Set<string>();
  let currentConfig = Object.freeze(structuredClone(config ?? {}));
  let installed = false;
  let applyingConfig = false;
  let applyConfig: Parameters<PluginApi['onConfigChange']>[0] | undefined;
  const inScope = (sessionId: string) => !scopeKey || address(sessionId).includes(scopeKey);
  const checkSession = (sessionId: string) => {
    lifetime.throwIfAborted();
    if (!inScope(sessionId)) throw new Error('Conversation outside plugin scope');
  };
  const hooks = executionHooks(ctx, id, state, inScope);
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
    const check = () => {
      lifetime.throwIfAborted();
      if (!installed || applyingConfig) throw new Error('Plugin settings cannot be written during setup or configuration callbacks');
    };
    check();
    if (!state.writeConfig || descriptor.configChanges !== 'live')
      throw new Error('Server plugin configuration writes require live configuration');
    let listener: ReturnType<typeof addAbortListener> | undefined;
    const aborted = new Promise<never>((_, reject) => {
      listener = addAbortListener(lifetime, () => reject(lifetime.reason));
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
    ...hooks.api,
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
    provide(name, service) {
      if (!descriptor.provides?.includes(name) || provided.has(name))
        throw new Error('Undeclared or duplicate service: ' + name);
      ctx.provide(name, service);
      provided.add(name);
    },
    service<Name extends keyof ServiceMap & string>(name: Name): NonNullable<ServiceMap[Name]> {
      if (!descriptor.inject?.includes(name)) throw new Error('Required service is not declared by ' + id + ': ' + name);
      const value = ctx.get(name) as ServiceMap[Name] | undefined;
      if (value == null) throw new Error('Required service is unavailable to ' + id + ': ' + name);
      return value;
    },
    optionalService<Name extends keyof ServiceMap & string>(name: Name): ServiceMap[Name] | undefined {
      if (!descriptor.optional?.includes(name)) throw new Error('Optional service is not declared by ' + id + ': ' + name);
      return ctx.get(name) as ServiceMap[Name] | undefined;
    },
    registerTool(tool) {
      const tools = api.service('harnessTools');
      return ctx.effect(() => tools.register(tool.name, () => tool, undefined, scopeKey));
    },
    registerRoute(method, path, handler) {
      if (scopeKey || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ||
          !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path)) throw new Error('Invalid plugin route');
      const routes = state.routes;
      if (!routes) throw new Error('HTTP routes are unavailable');
      return ctx.effect(() => routes.register(method, '/api/extensions/' + id + path, handler));
    },
    registerUpgrade(path, handler) {
      if (scopeKey || !state.upgrade || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+$/.test(path))
        throw new Error('Invalid WebSocket route');
      lifetime.throwIfAborted();
      const register = state.upgrade;
      return ctx.effect(() => {
        const release = register('/api/extensions/' + id + path, handler);
        lifetime.addEventListener('abort', release, { once: true });
        return () => { lifetime.removeEventListener('abort', release); release(); };
      });
    },
    records: {
      async list(sessionId) { checkSession(sessionId); return records(sessionId).list(); },
      async append(sessionId, data) { checkSession(sessionId); return records(sessionId).append(data); }
    },
    registerProjection(projection) {
      if (typeof projection.initial !== 'function' || typeof projection.reduce !== 'function')
        throw new Error('Invalid session record projection');
      lifetime.throwIfAborted();
      let active = true;
      const dispose = ctx.effect(() => () => { active = false; });
      return { async read(sessionId) {
        checkSession(sessionId);
        if (!active) throw new Error('Session record projection is disposed');
        return records(sessionId).list().reduce((state, record) => projection.reduce(state, record), projection.initial());
      }, dispose: () => { void dispose(); } };
    },
    onDispose: (dispose) => ctx.effect(() => dispose)
  };
  return { api, drain: hooks.drain, async updateConfig(next: Record<string, unknown>) {
    const config = Object.freeze(structuredClone(next));
    applyingConfig = true;
    try {
      await applyConfig?.(config);
      currentConfig = config;
    } finally { applyingConfig = false; }
  }, checkPublications() {
    if (descriptor.trustedCode && descriptor.provides?.some((service) => !provided.has(service)))
      throw new Error('Plugin did not publish all declared services: ' + id);
    installed = true;
  } };
}
