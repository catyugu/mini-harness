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
}

export function createPluginApi(ctx: Context, { id, descriptor, config }: { id: string; descriptor: PluginDescriptor; config?: Record<string, unknown> }, state: PluginLifetime) {
  const { scope, scopeKey, lifetime, records, address } = state;
  const provided = new Set<string>();
  const inScope = (sessionId: string) => !scopeKey || address(sessionId).includes(scopeKey);
  const checkSession = (sessionId: string) => {
    lifetime.throwIfAborted();
    if (!inScope(sessionId)) throw new Error('Conversation outside plugin scope');
  };
  const hooks = executionHooks(ctx, id, state, inScope);
  const api: PluginApi = {
    scope: Object.freeze({ ...scope }), signal: lifetime,
    config: Object.freeze(structuredClone(config ?? {})),
    ...hooks.api,
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
  return { api, drain: hooks.drain, checkPublications() {
    if (descriptor.trustedCode && descriptor.provides?.some((service) => !provided.has(service)))
      throw new Error('Plugin did not publish all declared services: ' + id);
  } };
}
