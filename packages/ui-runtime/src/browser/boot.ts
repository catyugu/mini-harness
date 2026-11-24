import type { BrowserPluginFailures } from './graph-api.js';
import { Context } from './vendor/cordis.js';
import { api, data, readEvents, wait, AuthenticationError } from './http.js';
import { RemoteStore } from './remote-store.js';
import { FrontendHost } from './frontend.js';
import { createBrowserGraphLoader } from './plugin-loader.js';
import { BrowserProjections } from './projections.js';
import type { BrowserBootstrap } from '../shared/bootstrap.js';
import type { ProjectionNotice } from '@mini-harness/transport/projection-notice';

/** A hash-only navigation does not reload ESM modules. Recover by reloading with the new credential. */
function acceptTokenFromUrl() {
  const token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!token) return false;
  const changed = sessionStorage.getItem('mini-harness-token') !== token;
  sessionStorage.setItem('mini-harness-token', token);
  history.replaceState(null, '', location.pathname + location.search);
  return changed;
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
  const lifetime = new AbortController();
  acceptTokenFromUrl();
  window.addEventListener('hashchange', () => {
    if (acceptTokenFromUrl()) location.reload();
  });
  const ctx = new Context();
  const graph = new RemoteStore(() => data<BrowserBootstrap>('/bootstrap', { signal: lifetime.signal }));
  const report = (error: Error) => window.dispatchEvent(new CustomEvent('mini-harness:error', { detail: error }));
  const projections = new BrowserProjections((domain, error) => {
    if (error instanceof AuthenticationError) showAuthenticationError(error);
    else report(new Error('Could not refresh ' + domain + ': ' + (error instanceof Error ? error.message : String(error))));
  });
  const host = new FrontendHost(ctx, data, report);
  const sync = createBrowserGraphLoader(host);
  const dispose = async () => {
    lifetime.abort();
    await host.dispose();
    await sync({ ui: [] });
  };
  const failuresChanged = new EventTarget();
  let currentFailures: BrowserPluginFailures = new Map();
  const applyGraph = async () => {
    const failures = await sync(graph.get());
    const changed = [...failures.keys()].some((id) => !currentFailures.has(id)) || failures.size !== currentFailures.size;
    if (changed) for (const [id, error] of failures) console.warn('Browser plugin ' + id, error);
    currentFailures = failures;
    const coreFailure = [...failures].find(([id]) => graph.get().ui.some((entry) => entry.id === id && entry.required));
    const status = document.getElementById('startupStatus');
    if (coreFailure && status) {
      status.hidden = false;
      status.textContent = 'Required UI plugin failed: ' + coreFailure[0] + ': ' + String(coreFailure[1]);
    }
    if (changed) failuresChanged.dispatchEvent(new Event('change'));
    return failures;
  };
  ctx.provide('miniProjections', projections);
  ctx.provide('miniBrowserFailures', {
    has: (id: string) => currentFailures.has(id),
    subscribe: (listener: () => void, signal: AbortSignal) => failuresChanged.addEventListener('change', listener, { signal })
  });
  ctx.provide('miniSwitch', async () => { await graph.refresh(); return applyGraph(); });
  try {
    await graph.refresh();
    const failures = await applyGraph();
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
      if (!event.persisted) void dispose();
    }, { signal: lifetime.signal });
  } catch (error) {
    await dispose();
    throw error;
  }
}

void boot().catch((error: Error) => {
  const status = document.getElementById('startupStatus');
  if (!status) return;
  status.hidden = false;
  status.textContent = error.message;
});
