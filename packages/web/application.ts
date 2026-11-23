import { Context } from './vendor/cordis.js';
import { data } from './api.js';
import { BrowserState } from './models/browser-state.js';
import { FrontendHost } from './kernel/extensions.js';
import { createPluginLoader, type BrowserPluginFailures } from './kernel/plugin-loader.js';
import { shellPlugin } from './ui/shell/index.js';
import type { conversationView } from '../sessions/browser/conversation/view.js';
import { conversationPlugin } from '../sessions/browser/conversation/plugin.js';
import { navigationPlugin } from '../sessions/browser/navigation-plugin.js';
import { settingsPlugin } from '../settings/browser.js';
import { workspacePlugin } from '../workspaces/browser.js';
import { modelPlugin } from '../models/browser.js';
import { catalogPlugin } from '../plugins/browser.js';
import { hydrateIcons } from './ui/components/icons.js';
import type { Bootstrap } from './types.js';

declare module 'cordis' {
  interface Context {
    miniState: BrowserState;
    miniHost: FrontendHost;
    miniConversation: ReturnType<typeof conversationView>;
    miniSwitch: (snapshot: Bootstrap) => Promise<BrowserPluginFailures>;
  }
}

const plugins = [shellPlugin, workspacePlugin, navigationPlugin, conversationPlugin, settingsPlugin, modelPlugin, catalogPlugin];

export async function mountBrowser(ctx: Context, snapshot: Bootstrap) {
  const state = new BrowserState(snapshot);
  const report = (error: Error) => state.dispatchEvent(new CustomEvent('error', { detail: error }));
  const host = new FrontendHost(ctx, data, {
    bootstrap: state.get,
    workspace: state.scope,
    session: state.session,
    onConversationChange: (listener, signal) => state.on('navigation', listener, signal),
    openConversation: (id) => { state.dispatchEvent(new CustomEvent('open', { detail: id })); },
    report
  });
  const sync = createPluginLoader(host);
  const load = async (snapshot: Bootstrap) => {
    const failures = await sync(snapshot);
    state.dispatchEvent(new Event('plugins'));
    return failures;
  };
  ctx.provide('miniState', state);
  ctx.provide('miniHost', host);
  ctx.provide('miniSwitch', load);
  try {
    for (const plugin of plugins) await host.mountPlugin(plugin);
    const failures = await load(state.get());
    if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
    hydrateIcons();
  } catch (error) {
    await host.dispose();
    throw error;
  }
  return () => host.dispose();
}
