import type { FrontendHost, FrontendSetup } from './frontend.js';
import type { Bootstrap } from '@mini-harness/web/types';
import type { BrowserEntry } from '@mini-harness/contracts/browser';
import { data } from '@mini-harness/web/api';

export type BrowserPluginFailures = ReadonlyMap<string, unknown>;

export function createBrowserGraphLoader(host: FrontendHost) {
  const mounted = new Map<string, string>();
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
      const { requires } = enabled.get(id)!;
      for (const parent of requires ?? []) visit(parent, visiting);
      const { browser, web, config } = enabled.get(id);
      const key = JSON.stringify([browser, web, config, requires, enabled.get(id).inject]);
      visiting.delete(id);
      signatures.set(id, key);
      ordered.push(id);
    };
    for (const id of enabled.keys()) visit(id);
    const affected = new Set(ordered.filter((id) => mounted.get(id) !== signatures.get(id)));
    for (const id of ordered) if (enabled.get(id).requires?.some((dependency) => affected.has(dependency))) affected.add(id);
    const failed = new Map<string, unknown>();
    for (const id of [...mounted.keys()].reverse()) {
      if (enabled.has(id) && !affected.has(id)) continue;
      mounted.delete(id);
      try { await host.disable(id); }
      catch (error) { failed.set(id, error); }
    }
    for (const id of ordered) {
      const key = signatures.get(id);
      const plugin = enabled.get(id)!;
      if ((!plugin.browser && !plugin.web) || mounted.has(id)) continue;
      try {
        if (failed.has(id) || plugin.requires?.some((parent) => failed.has(parent)))
          throw failed.get(id) ?? new Error('Browser dependency failed');
        let setup: FrontendSetup;
        const config = plugin.config;
        if (plugin.browser) setup = (await import(plugin.browser)).default;
        else {
          const sourceData = await data<{ source: string }>('/plugins/' + id + '/web');
          const url = URL.createObjectURL(new Blob([sourceData.source], { type: 'text/javascript' }));
          try { setup = (await import(url)).default; }
          finally { URL.revokeObjectURL(url); }
        }
        if (typeof setup !== 'function') throw new Error('Expected a default browser setup function: ' + id);
        await host.mount(id, setup, plugin.inject ?? [], config);
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
