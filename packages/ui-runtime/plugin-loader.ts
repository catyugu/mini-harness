import type { FrontendHost, FrontendSetup } from './frontend.js';
import type { Bootstrap } from '@mini-harness/web/types';
import type { BrowserEntry } from '@mini-harness/contracts/browser';

export type BrowserPluginFailures = ReadonlyMap<string, unknown>;

export function createBrowserGraphLoader(host: FrontendHost) {
  const mounted = new Map<string, string>();
  const styles = new Map<string, HTMLLinkElement[]>();
  const preloads = new Map<string, { url: string; lifetime: AbortController; dispose?: () => void | Promise<void> }>();
  let work = Promise.resolve();

  async function sync(snapshot: Bootstrap): Promise<BrowserPluginFailures> {
    const enabled = new Map<string, BrowserEntry>(snapshot.ui.map((entry) => [entry.id, entry]));
    if (enabled.size !== snapshot.ui.length) throw new Error('Duplicate browser plugin ID in composed graph');
    const signatures = new Map<string, string>();
    const ordered: string[] = [];
    const visit = (id: string, visiting = new Set<string>()) => {
      if (signatures.has(id)) return;
      if (visiting.has(id) || !enabled.has(id)) throw new Error('Invalid browser plugin dependency: ' + id);
      visiting.add(id);
      const plugin = enabled.get(id);
      if (!plugin) throw new Error('Missing browser plugin entry: ' + id);
      const { requires, browser, styles, config, inject } = plugin;
      for (const parent of requires ?? []) visit(parent, visiting);
      const key = JSON.stringify([browser, styles, config, requires, inject]);
      visiting.delete(id);
      signatures.set(id, key);
      ordered.push(id);
    };
    for (const id of enabled.keys()) visit(id);
    const affected = new Set(ordered.filter((id) => mounted.get(id) !== signatures.get(id)));
    for (const id of ordered) if (enabled.get(id)?.requires?.some((dependency) => affected.has(dependency))) affected.add(id);
    const failed = new Map<string, unknown>();
    for (const id of [...mounted.keys()].reverse()) {
      if (enabled.has(id) && !affected.has(id)) continue;
      mounted.delete(id);
      for (const link of styles.get(id) ?? []) link.remove();
      styles.delete(id);
      try { await host.disable(id); }
      catch (error) { failed.set(id, error); }
    }
    for (const [id, preload] of [...preloads].reverse()) {
      if (enabled.get(id)?.preload === preload.url) continue;
      preloads.delete(id);
      preload.lifetime.abort();
      try { await preload.dispose?.(); } catch (error) { failed.set(id, error); }
    }
    for (const id of ordered) {
      const url = enabled.get(id)?.preload;
      if (!url || preloads.has(id)) continue;
      const lifetime = new AbortController();
      try {
        const script = await import(url);
        if (typeof script.default !== 'function') throw new Error('Expected a default pre-start entry: ' + id);
        const dispose: unknown = await script.default(lifetime.signal);
        if (dispose !== undefined && typeof dispose !== 'function') throw new Error('Invalid pre-start cleanup: ' + id);
        preloads.set(id, { url, lifetime, dispose: dispose as (() => void | Promise<void>) | undefined });
      } catch (error) {
        lifetime.abort();
        failed.set(id, error);
      }
    }
    for (const id of ordered) {
      const key = signatures.get(id);
      const plugin = enabled.get(id);
      if (key === undefined || !plugin) throw new Error('Browser dependency graph has an unresolved entry: ' + id);
      if (!plugin.browser || mounted.has(id)) continue;
      try {
        if (failed.has(id) || plugin.requires?.some((parent) => failed.has(parent)))
          throw failed.get(id) ?? new Error('Browser dependency failed');
        const setup: FrontendSetup = (await import(plugin.browser)).default;
        if (typeof setup !== 'function') throw new Error('Expected a default browser setup function: ' + id);
        await host.mount(id, setup, plugin.inject ?? [], plugin.config);
        styles.set(id, (plugin.styles ?? []).map((href) => {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          document.head.append(link);
          return link;
        }));
        mounted.set(id, key);
      } catch (error) {
        failed.set(id, error);
      }
    }
    return failed;
  }

  return (snapshot: Bootstrap) => {
    const update = work.then(() => sync(snapshot));
    work = update.then(() => {}, () => {});
    return update;
  };
}
