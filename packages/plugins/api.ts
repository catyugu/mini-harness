import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readJson, writeJson } from '@mini-harness/platform/config';
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
  upgrade?(path: string, handler: import('@mini-harness/contracts/routes').UpgradeHandler): () => void;
}

export function createPluginApi(ctx: Context, { id, descriptor, config }: { id: string; descriptor: PluginDescriptor; config?: Record<string, unknown> }, state: PluginLifetime) {
  const { scope, scopeKey, lifetime, records, address } = state;
  const provided = new Set<string>();
  let currentConfig = Object.freeze(structuredClone(config ?? {}));
  let applyConfig: Parameters<PluginApi['onConfigChange']>[0] | undefined;
  const inScope = (sessionId: string) => !scopeKey || address(sessionId).includes(scopeKey);
  const checkSession = (sessionId: string) => {
    lifetime.throwIfAborted();
    if (!inScope(sessionId)) throw new Error('Conversation outside plugin scope');
  };
  const hooks = executionHooks(ctx, id, state, inScope);
  const instance = scopeKey ? createHash('sha256').update(scopeKey).digest('hex') : 'application';
  const storagePath = (name: string) => {
    lifetime.throwIfAborted();
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error('Invalid private data name');
    const root = join(state.dataRoot, id, instance);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (relative(root, realpathSync(root))) throw new Error('Plugin data directory was redirected');
    const file = join(root, name + '.json');
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.nlink !== 1)) throw new Error('Invalid plugin data file');
    return file;
  };
  const api: PluginApi = {
    scope: Object.freeze({ ...scope }), signal: lifetime,
    get config() { return currentConfig; },
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
      const routes = api.service('harnessRoutes');
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
    if (!applyConfig) throw new Error('Live configuration handler is missing');
    await applyConfig(config);
    currentConfig = config;
  }, checkPublications() {
    if (descriptor.configChanges === 'live' && !applyConfig) throw new Error('Live configuration handler is missing: ' + id);
    if (descriptor.trustedCode && descriptor.provides?.some((service) => !provided.has(service)))
      throw new Error('Plugin did not publish all declared services: ' + id);
  } };
}
