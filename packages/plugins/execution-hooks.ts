import type { Context } from 'cordis';
import type { PluginApi } from '@mini-harness/contracts/plugins';
import type { ModelRequestTransform, ToolResultTransform } from '@mini-harness/contracts/extensions';
import type { OrderedHook } from '@mini-harness/contracts/events';
import type { PluginLifetime } from './api.js';

export function executionHooks(ctx: Context, id: string, { lifetime, scopeKey, address }: PluginLifetime,
  inScope: (sessionId: string) => boolean) {
  const active = new Set<Promise<unknown>>();
  const visible = (sessionId: string) => !lifetime.aborted && inScope(sessionId);
  const sections = new Set<string>();

  async function run<T>(work: (signal: AbortSignal) => T | Promise<T>, request?: AbortSignal): Promise<T> {
    const signal = request ? AbortSignal.any([lifetime, request]) : lifetime;
    signal.throwIfAborted();
    const pending = Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); });
    active.add(pending);
    try {
      const result = await pending;
      signal.throwIfAborted();
      return result;
    } finally { active.delete(pending); }
  }

  function ordered<T extends ModelRequestTransform | ToolResultTransform>(handler: T, order: number) {
    if (typeof handler !== 'function' || !Number.isFinite(order)) throw new Error('Invalid agent transform');
    return { pluginId: id, order };
  }

  const api: Pick<PluginApi, 'observe' | 'decideTool' | 'promptSection' | 'modelRequest' | 'toolResult' | 'retryModel' | 'transformTool'> = {
    observe: (handler) => ctx.on('harness/observe', (event) => {
      if (lifetime.aborted) return;
      const scoped = event.type === 'session-deleted' ? !scopeKey || event.scopeKeys.includes(scopeKey) : inScope(event.sessionId);
      if (scoped) void run(() => handler(structuredClone(event))).catch(() => {
        if (!lifetime.aborted) ctx.logger.warn('Plugin observer failed: ' + id);
      });
    }),
    decideTool: (handler) => ctx.on('harness/tool-decision', async (request) => {
      if (!visible(request.sessionId)) return;
      const decision = await run((signal) => handler({ ...request, arguments: structuredClone(request.arguments), signal }), request.signal);
      if (decision !== undefined && decision !== 'deny') throw new Error('Invalid tool policy decision: ' + id);
      return decision;
    }),
    promptSection: ({ id: sectionId, order = 500, render }) => {
      if (!/^[a-zA-Z][a-zA-Z0-9_.:-]{0,95}$/.test(sectionId) || !Number.isFinite(order) ||
          typeof render !== 'function' || sections.has(sectionId)) throw new Error('Invalid or duplicate prompt section: ' + sectionId);
      lifetime.throwIfAborted();
      sections.add(sectionId);
      let registered = true;
      const unregister = ctx.on('harness/prompt-sections', (sessionId, items) => {
        if (!visible(sessionId)) return;
        const depth = scopeKey ? address(sessionId).indexOf(scopeKey) + 1 : 0;
        items.push({ id: sectionId, order, depth, pluginId: id, render(request) {
          if (!registered) return;
          const { signal, ...input } = request;
          return run((signal) => render({ ...structuredClone(input), signal }), signal);
        } });
      });
      return () => {
        if (!registered) return;
        registered = false;
        sections.delete(sectionId);
        unregister();
      };
    },
    modelRequest(handler, order = 0) {
      const hook: OrderedHook<ModelRequestTransform> = { ...ordered(handler, order), transform(value, context) {
        return run((signal) => handler(structuredClone(value), { ...context, model: { ...context.model }, signal }), context.signal);
      } };
      return ctx.on('harness/model-request', (sessionId, handlers) => { if (visible(sessionId)) handlers.push(hook); });
    },
    toolResult(handler, order = 0) {
      const hook: OrderedHook<ToolResultTransform> = { ...ordered(handler, order), transform(content, context) {
        return run((signal) => handler(structuredClone(content), { ...context, model: { ...context.model }, signal }), context.signal);
      } };
      return ctx.on('harness/tool-result', (sessionId, handlers) => { if (visible(sessionId)) handlers.push(hook); });
    },
    retryModel: (handler) => ctx.on('harness/model-retry', async (failure) => {
      if (!visible(failure.sessionId)) return;
      const retry = await run((signal) => handler({ ...failure, model: { ...failure.model }, signal }), failure.signal);
      if (retry !== undefined && (!retry || typeof retry !== 'object' ||
          (retry.delayMs !== undefined && (!Number.isFinite(retry.delayMs) || retry.delayMs < 0 || retry.delayMs > 30000))))
        throw new Error('Invalid model retry decision: ' + id);
      return retry;
    }),
    transformTool: (handler) => ctx.on('harness/tool-projection', (request, next) => {
      const content = next();
      if (!visible(request.sessionId)) return content;
      try { return handler(structuredClone({ ...request, content })) ?? content; }
      catch { ctx.logger.warn('Plugin tool projection failed: ' + id); return content; }
    })
  };
  return { api, async drain() { await Promise.allSettled(active); } };
}
