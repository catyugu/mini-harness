import { Context } from './vendor/cordis.js';
import { data } from './api.js';
import { BrowserState } from './models/browser-state.js';
import { FrontendHost } from './kernel/extensions.js';
import { createBrowserGraphLoader, type BrowserPluginFailures } from './kernel/plugin-loader.js';
import type { Bootstrap } from './types.js';

declare module 'cordis' {
  interface Context {
    miniState: BrowserState;
    miniHost: FrontendHost;
    miniSwitch: (snapshot: Bootstrap) => Promise<BrowserPluginFailures>;
  }
}

/** No feature imports or built-in plugin list here. The Host supplies the UI graph. */
async function boot() {
  const snapshot = await data<Bootstrap>('/bootstrap');
  const ctx = new Context();
  const state = new BrowserState(snapshot);
  const report = (error: Error) => state.dispatchEvent(new CustomEvent('error', { detail: error }));
  const host = new FrontendHost(ctx, data, {
    bootstrap: state.get, workspace: state.scope, session: state.session,
    onConversationChange: (listener, signal) => state.on('navigation', listener, signal),
    openConversation: (id) => state.dispatchEvent(new CustomEvent('open', { detail: id })),
    report
  });
  const sync = createBrowserGraphLoader(host);
  const load = async (snapshot: Bootstrap) => {
    const failures = await sync(snapshot);
    state.dispatchEvent(new Event('plugins'));
    return failures;
  };
  ctx.provide('miniState', state);
  ctx.provide('miniHost', host);
  ctx.provide('miniSwitch', load);
  try {
    const failures = await load(snapshot);
    const coreFailure = [...failures].find(([id]) => snapshot.ui.some((entry) => entry.id === id));
    if (coreFailure) throw new Error('Required UI plugin failed: ' + coreFailure[0] + ': ' + String(coreFailure[1]));
    if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
  } catch (error) {
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
