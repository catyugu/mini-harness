import type {} from './graph-api.js';
import type { PluginConfiguration } from '@mini-harness/kernel/configuration';
import type { BrowserContributionSource, BrowserRelease } from './contribution.js';
import type { Context, Fiber } from './vendor/cordis.js';

import type { FrontendSetup } from './frontend-api.js';
import type {} from './projection-api.js';

export class FrontendHost {
  private readonly plugins = new Map<string, { fiber: Fiber; controller: AbortController; configure(config: Record<string, unknown>): void }>();
  private disposed = false;
  constructor(
    private readonly ctx: Context,
    private readonly request: <T>(path: string, options?: RequestInit) => Promise<T>,
    private readonly report: (error: Error) => void
  ) {}

  async mount(id: string, setup: FrontendSetup, inject: string[], config: Record<string, unknown> = {}) {
    if (this.disposed) throw new Error('Browser host is disposed');
    await this.disable(id);
    if (this.disposed) throw new Error('Browser host is disposed');
    const controller = new AbortController();
    const root = this.ctx;
    let installed = false;
    let snapshot = Object.freeze(structuredClone(config));
    const listeners = new Set<() => void>();
    const readValue = <T>(key: string): T => {
      controller.signal.throwIfAborted();
      return (Object.hasOwn(snapshot, key) ? structuredClone(snapshot[key]) : undefined) as T;
    };
    const patch = async (values: Record<string, unknown>) => {
      controller.signal.throwIfAborted();
      if (!installed) throw new Error('Plugin settings cannot be written during browser setup');
      await this.request('/settings/plugins/' + encodeURIComponent(id), {
        method: 'PATCH', body: JSON.stringify(values), signal: controller.signal
      });
      await root.miniSwitch();
    };
    const configuration: PluginConfiguration = {
      get: readValue, patch,
      set: (key, value) => patch({ [key]: value }),
      subscribe<T>(key: string, listener: (value: T) => void) {
        let previous = JSON.stringify(readValue(key));
        const changed = () => {
          const value = readValue<T>(key);
          const serialized = JSON.stringify(value);
          if (serialized === previous) return;
          previous = serialized;
          listener(value);
        };
        listeners.add(changed);
        return () => { listeners.delete(changed); };
      }
    };
    controller.signal.addEventListener('abort', () => listeners.clear(), { once: true });
    const fiber = this.ctx.inject(inject, async (ctx) => {
      const own = (install: () => BrowserRelease) => ctx.effect(install);
      const contribution: BrowserContributionSource = {
        id, signal: controller.signal, configuration, effect: own,
        service(name) {
          if (!inject.includes(name)) throw new Error('Undeclared browser service for ' + id + ': ' + name);
          const service = ctx.get(name);
          if (service == null) throw new Error('Browser service is unavailable: ' + name);
          return service;
        }
      };
      const cleanup = await setup(ctx, {
        signal: controller.signal,
        contribute(point, ...args) {
          controller.signal.throwIfAborted();
          return point(contribution, ...args);
        },
        watch: (refresh) => own(() => root.miniProjections.register('plugin:' + id, { sync: refresh })),
        locale: {
          current: () => navigator.language,
          subscribe: (listener) => {
            const change = () => listener(navigator.language);
            window.addEventListener('languagechange', change, { signal: controller.signal });
            return () => window.removeEventListener('languagechange', change);
          },
          text: (messages, fallback) => messages[navigator.language] ?? messages[navigator.language.split('-')[0]] ?? fallback
        },
        request: (path, options) => this.request(path, { ...options, signal: options?.signal
          ? AbortSignal.any([controller.signal, options.signal]) : controller.signal }),
        get config() { return snapshot; },
        configuration,
        onDispose: (dispose) => {
          if (controller.signal.aborted) { void Promise.resolve().then(dispose).catch(this.report); return () => {}; }
          return own(() => dispose);
        }
      });
      if (cleanup) {
        if (controller.signal.aborted) await cleanup();
        else own(() => cleanup);
      }
    });
    this.plugins.set(id, { fiber, controller, configure: (next) => {
      snapshot = Object.freeze(structuredClone(next));
      for (const listener of listeners) {
        try { listener(); }
        catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
      }
    } });
    try { await fiber.await(); installed = true; }
    catch (error) {
      await this.disable(id);
      throw error;
    }
  }

  configure(id: string, config: Record<string, unknown>) {
    this.plugins.get(id)?.configure(config);
  }

  async disable(id: string) {
    const plugin = this.plugins.get(id);
    if (!plugin) return;
    this.plugins.delete(id);
    plugin.controller.abort();
    await plugin.fiber.dispose();
  }

  async dispose() {
    this.disposed = true;
    for (const id of [...this.plugins.keys()].reverse()) {
      try { await this.disable(id); }
      catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
    }
  }
}
