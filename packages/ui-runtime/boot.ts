import { Context } from '../web/vendor/cordis.js';
import { api, data, readEvents, wait } from '../web/api.js';
import { RemoteStore } from '../web/models/remote-store.js';
import type { SlotRegistry } from '../ui-slots/registry.js';
import type { MessageExtensions } from './message-extensions.js';
import { FrontendHost } from './frontend.js';
import { createBrowserGraphLoader, type BrowserPluginFailures } from './plugin-loader.js';
import { BrowserProjections } from './projections.js';
import type { Bootstrap } from '../web/types.js';
import type { ProjectionNotice } from '../contracts/navigation.js';

declare module 'cordis' {
  interface Context {
    miniSlots: SlotRegistry;
    miniMessages: MessageExtensions;
    miniSwitch: () => Promise<BrowserPluginFailures>;
  }
}

async function observe(projections: BrowserProjections, signal: AbortSignal) {
  let backoff = 300;
  while (!signal.aborted) {
    try {
      const connection = new AbortController();
      const streamSignal = AbortSignal.any([signal, connection.signal]);
      await readEvents<ProjectionNotice>(await api('/changes', { signal: streamSignal }), (event) => {
        backoff = 300;
        void projections.dispatch(event).catch(() => connection.abort());
      });
    } catch { /* Reconnection sends a complete revision snapshot. */ }
    await wait(backoff, signal);
    backoff = Math.min(5000, backoff * 2);
  }
}

async function boot() {
  const ctx = new Context();
  const lifetime = new AbortController();
  const projections = new BrowserProjections();
  const graph = new RemoteStore(() => data<Bootstrap>('/bootstrap', { signal: lifetime.signal }));
  const report = (error: Error) => window.dispatchEvent(new CustomEvent('mini-harness:error', { detail: error }));
  const host = new FrontendHost(ctx, data, report);
  const sync = createBrowserGraphLoader(host);
  const applyGraph = () => sync(graph.get());
  ctx.provide('miniProjections', projections);
  ctx.provide('miniSwitch', async () => { await graph.refresh(); return applyGraph(); });
  try {
    await graph.refresh();
    const failures = await applyGraph();
    const coreFailure = [...failures].find(([id]) => graph.get().ui.some((entry) => entry.id === id && entry.required));
    if (coreFailure) throw new Error('Required UI plugin failed: ' + coreFailure[0] + ': ' + String(coreFailure[1]));
    if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
    const release = projections.register('plugins', {
      async sync(revision, reconnect) {
        await graph.sync(revision, reconnect);
        const failures = await applyGraph();
        if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
      }
    });
    lifetime.signal.addEventListener('abort', release, { once: true });
    void observe(projections, lifetime.signal);
    window.addEventListener('pagehide', (event) => {
      if (!event.persisted) { lifetime.abort(); void host.dispose(); }
    }, { signal: lifetime.signal });
  } catch (error) {
    lifetime.abort();
    await host.dispose();
    throw error;
  }
}

void boot().catch((error: Error) => {
  const status = document.getElementById('startupStatus');
  if (!status) return;
  status.hidden = false;
  status.textContent = error.message;
});
