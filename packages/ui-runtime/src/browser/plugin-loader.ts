import type { BrowserPluginFailures } from './graph-api.js';
async function loadStyle(href: string, link: HTMLLinkElement) {
  link.rel = 'stylesheet';
  link.href = href;
  const timeout = AbortSignal.timeout(8000);
  await new Promise<void>((resolve, reject) => {
    const fail = () => reject(new Error('Could not load browser stylesheet'));
    timeout.addEventListener('abort', fail, { once: true });
    link.onload = () => { timeout.removeEventListener('abort', fail); resolve(); };
    link.onerror = () => { timeout.removeEventListener('abort', fail); fail(); };
    document.head.append(link);
  });
}
import type { FrontendHost } from './frontend.js';
import type { FrontendSetup } from './frontend-api.js';
import type { BrowserBootstrap, BrowserEntry } from '../shared/bootstrap.js';


export function createBrowserGraphLoader(host: FrontendHost) {
  const mounted = new Map<string, string>();
  const styles = new Map<string, HTMLLinkElement[]>();
  const preloads = new Map<string, { url: string; lifetime: AbortController; dispose?: () => void | Promise<void> }>();
  let work = Promise.resolve();

  async function releasePreload(id: string) {
    const preload = preloads.get(id);
    if (!preload) return;
    preloads.delete(id);
    preload.lifetime.abort();
    await preload.dispose?.();
  }

  function failure(stage: string, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return new Error('Browser ' + stage + ' failed: ' + message, { cause: error });
  }

  async function sync(snapshot: BrowserBootstrap): Promise<BrowserPluginFailures> {
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
      const { requires, browser, styles, preload, config, inject, provides, liveConfig } = plugin;
      for (const parent of requires ?? []) visit(parent, visiting);
      const key = JSON.stringify([browser, styles, preload, liveConfig, liveConfig ? undefined : config, requires, inject, provides]);
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
      catch (error) { failed.set(id, failure('cleanup', error)); }
    }
    for (const [id, preload] of [...preloads].reverse()) {
      if (enabled.get(id)?.preload === preload.url) continue;
      try { await releasePreload(id); } catch (error) { failed.set(id, failure('cleanup', error)); }
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
        failed.set(id, failure('preload', error));
      }
    }
    for (const id of ordered) {
      const key = signatures.get(id);
      const plugin = enabled.get(id);
      if (key === undefined || !plugin) throw new Error('Browser dependency graph has an unresolved entry: ' + id);
      if (!plugin.browser) continue;
      if (mounted.has(id)) {
        if (plugin.liveConfig) host.configure(id, plugin.config);
        continue;
      }
      let stage = 'dependency';
      try {
        if (failed.has(id)) throw failed.get(id);
        const dependency = plugin.requires?.find((parent) => failed.has(parent));
        if (dependency) throw new Error(dependency, { cause: failed.get(dependency) });
        stage = 'stylesheet load';
        const links = (plugin.styles ?? []).map(() => document.createElement('link'));
        styles.set(id, links);
        await Promise.all((plugin.styles ?? []).map((href, index) => loadStyle(href, links[index])));
        stage = 'module load';
        const setup: FrontendSetup = (await import(plugin.browser)).default;
        if (typeof setup !== 'function') throw new Error('Expected a default browser setup function: ' + id);
        stage = 'setup';
        await host.mount(id, setup, plugin.inject ?? [], plugin.provides ?? [], plugin.config);
        mounted.set(id, key);
      } catch (error) {
        for (const link of styles.get(id) ?? []) link.remove();
        styles.delete(id);
        try { await releasePreload(id); }
        catch (cleanupError) { error = new AggregateError([error, cleanupError], 'Browser plugin setup and cleanup failed'); }
        failed.set(id, failed.has(id) ? error : failure(stage, error));
      }
    }
    return failed;
  }

  return (snapshot: BrowserBootstrap) => {
    const update = work.then(() => sync(snapshot));
    work = update.then(() => {}, () => {});
    return update;
  };
}
