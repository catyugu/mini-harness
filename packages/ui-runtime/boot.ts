import { Context } from '@mini-harness/web/vendor/cordis';
import { api, data, readEvents, wait, AuthenticationError } from '@mini-harness/web/api';
import { RemoteStore } from '@mini-harness/web/models/remote-store';
import type { SlotRegistry } from '@mini-harness/ui-slots/registry';
import type { MessageExtensions } from './message-extensions.js';
import { FrontendHost } from './frontend.js';
import { createBrowserGraphLoader, type BrowserPluginFailures } from './plugin-loader.js';
import { BrowserProjections } from './projections.js';
import type { Bootstrap } from '@mini-harness/web/types';
import type { ProjectionNotice } from '@mini-harness/contracts/navigation';

declare module 'cordis' {
  interface Context {
    miniSlots: SlotRegistry;
    miniMessages: MessageExtensions;
    miniSwitch: () => Promise<BrowserPluginFailures>;
  }
}

function showAuthenticationError(error: AuthenticationError) {
  const status = document.getElementById('startupStatus');
  if (!status) return;
  status.hidden = false;
  status.textContent = error.message;
}

async function observe(projections: BrowserProjections, signal: AbortSignal) {
  let backoff = 300;
  while (!signal.aborted) {
    try {
      const connectedAt = performance.now();
      await readEvents<ProjectionNotice>(await api('/changes', { signal }), (event) => { void projections.dispatch(event); });
      if (performance.now() - connectedAt > 10000) backoff = 300;
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof AuthenticationError) {
        showAuthenticationError(error);
        break; // A stale token will not heal through connection retries.
      }
      // Transient disconnections retry with a complete revision snapshot.
    }
    await wait(backoff, signal);
    backoff = Math.min(5000, backoff * 2);
  }
}

async function boot() {
  const ctx = new Context();
  const lifetime = new AbortController();
  const graph = new RemoteStore(() => data<Bootstrap>('/bootstrap', { signal: lifetime.signal }));
  const report = (error: Error) => window.dispatchEvent(new CustomEvent('mini-harness:error', { detail: error }));
  const projections = new BrowserProjections((domain, error) => {
    if (error instanceof AuthenticationError) showAuthenticationError(error);
    else report(new Error('Could not refresh ' + domain + ': ' + (error instanceof Error ? error.message : String(error))));
  });
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
