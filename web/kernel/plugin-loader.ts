import type { FrontendHost, FrontendSetup } from './extensions.js';
import type { Bootstrap } from '../types.js';
import { data } from '../api.js';

export type BrowserPluginFailures = ReadonlyMap<string, unknown>;

export function createPluginLoader(host: FrontendHost) {
  const mounted = new Map<string, string>();
  let work = Promise.resolve();

  async function sync(snapshot: Bootstrap): Promise<BrowserPluginFailures> {
    const enabled = new Map(snapshot.plugins.filter(({ id }) => snapshot.settings.plugins[id]).map((plugin) => [plugin.id, plugin]));
    const signatures = new Map<string, string>();
    const signature = (id: string, visiting = new Set<string>()): string => {
      if (signatures.has(id)) return signatures.get(id);
      if (visiting.has(id) || !enabled.has(id)) throw new Error('Invalid browser plugin dependency: ' + id);
      visiting.add(id);
      const { requires } = enabled.get(id);
      const key = JSON.stringify([snapshot.settings.pluginConfig[id] ?? {}, ...(requires ?? []).map((parent) => signature(parent, visiting))]);
      visiting.delete(id);
      signatures.set(id, key);
      return key;
    };
    for (const id of enabled.keys()) signature(id);
    const failed = new Map<string, unknown>();
    for (const [id, key] of [...mounted].reverse()) {
      if (signatures.get(id) === key) continue;
      mounted.delete(id);
      try { await host.disable(id); }
      catch (error) { failed.set(id, error); }
    }
    for (const [id, key] of signatures) {
      const plugin = enabled.get(id);
      if ((!plugin.browser && !plugin.web) || mounted.has(id)) continue;
      try {
        if (failed.has(id) || plugin.requires?.some((parent) => failed.has(parent)))
          throw failed.get(id) ?? new Error('Browser dependency failed');
        let setup: FrontendSetup;
        let config = snapshot.settings.pluginConfig[id];
        if (plugin.browser) setup = (await import(plugin.browser)).default;
        else {
          const sourceData = await data<{ source: string; config: Record<string, unknown> }>('/plugins/' + id + '/web');
          config = sourceData.config;
          const url = URL.createObjectURL(new Blob([sourceData.source], { type: 'text/javascript' }));
          try { setup = (await import(url)).default; }
          finally { URL.revokeObjectURL(url); }
        }
        if (typeof setup !== 'function') throw new Error('Plugin UI must export a default setup function: ' + id);
        await host.enable(id, setup, config);
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
