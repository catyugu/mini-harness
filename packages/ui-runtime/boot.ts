import { Context } from '../web/vendor/cordis.js';
import { api, data, readEvents, wait } from '../web/api.js';
import { Selection } from '../web/models/selection.js';
import { RemoteStore } from '../web/models/remote-store.js';
import { SlotRegistry } from '../ui-slots/registry.js';
import { MessageExtensions } from './message-extensions.js';
import { FrontendHost } from './frontend.js';
import { createBrowserGraphLoader, type BrowserPluginFailures } from './plugin-loader.js';
import type { Bootstrap, ModelCatalog } from '../web/types.js';
import type { Settings } from '../contracts/config.js';
import type { Conversation } from '../contracts/conversation.js';
import type { WorkspaceRecord } from '../contracts/workspace.js';
import type { PluginMetadata } from '../contracts/plugins.js';
import type { ProjectionDomain, ProjectionNotice } from '../contracts/navigation.js';
import type { Approval } from '../contracts/approval.js';

declare module 'cordis' {
  interface Context {
    miniSlots: SlotRegistry;
    miniMessages: MessageExtensions;
    miniSelection: Selection;
    miniSessions: RemoteStore<Conversation[]>;
    miniWorkspaces: RemoteStore<WorkspaceRecord[]>;
    miniSettingsData: RemoteStore<Settings>;
    miniModels: RemoteStore<ModelCatalog>;
    miniPluginData: RemoteStore<PluginMetadata[]>;
    miniApprovals: RemoteStore<Approval[]>;
    miniSwitch: () => Promise<BrowserPluginFailures>;
  }
}

async function observe(stores: Record<ProjectionDomain, Pick<RemoteStore<unknown>, 'sync'>>, signal: AbortSignal) {
  let backoff = 300;
  while (!signal.aborted) {
    try {
      const connection = new AbortController();
      const streamSignal = AbortSignal.any([signal, connection.signal]);
      const recover = () => connection.abort();
      await readEvents<ProjectionNotice>(await api('/changes', { signal: streamSignal }), (event) => {
        backoff = 300;
        if (event.type === 'change') {
          void stores[event.domain].sync(event.revision, false)?.catch(recover);
        } else {
          for (const domain of Object.keys(stores) as ProjectionDomain[])
            void stores[domain].sync(event.revisions[domain], true)?.catch(recover);
        }
      });
    } catch { /* The next connection invalidates all snapshots. */ }
    await wait(backoff, signal);
    backoff = Math.min(5000, backoff * 2);
  }
}

async function boot() {
  const ctx = new Context();
  const lifetime = new AbortController();
  const select = new Selection();
  const settings = new RemoteStore(() => data<Settings>('/settings'));
  const sessions = new RemoteStore(async () => (await data<Conversation[]>('/sessions'))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  const workspaces = new RemoteStore(() => data<WorkspaceRecord[]>('/workspaces'));
  const models = new RemoteStore(async () => {
    const [{ models }, providers] = await Promise.all([
      data<Pick<ModelCatalog, 'models'>>('/models'), data<ModelCatalog['providers']>('/providers')
    ]);
    return { models, providers };
  });
  const plugins = new RemoteStore(() => data<PluginMetadata[]>('/plugins'));
  const approvals = new RemoteStore(() => data<Approval[]>('/approvals'));
  const graph = new RemoteStore(() => data<Bootstrap>('/bootstrap'));
  const report = (error: Error) => select.dispatchEvent(new CustomEvent('error', { detail: error }));
  const host = new FrontendHost(ctx, data, {
    workspace: select.scope, workspaceRecord: (id) => workspaces.get().find((record) => record.id === id),
    session: (id = select.activeConversation) => sessions.get().find((item) => item.id === id),
    onConversationChange(listener, signal) {
      select.subscribe(listener, signal);
      sessions.subscribe(listener, signal);
    },
    openConversation: (id) => select.dispatchEvent(new CustomEvent('open', { detail: id })),
    report
  });
  const sync = createBrowserGraphLoader(host);
  const applyGraph = async () => {
    const failures = await sync(graph.get());
    return failures;
  };
  const refreshGraph = async () => {
    await Promise.all([graph.refresh(), settings.refresh(), plugins.refresh()]);
    return applyGraph();
  };

  ctx.provide('miniSlots', new SlotRegistry());
  ctx.provide('miniMessages', new MessageExtensions(report));
  ctx.provide('miniSelection', select);
  ctx.provide('miniSettingsData', settings);
  ctx.provide('miniSessions', sessions);
  ctx.provide('miniWorkspaces', workspaces);
  ctx.provide('miniModels', models);
  ctx.provide('miniPluginData', plugins);
  ctx.provide('miniApprovals', approvals);
  ctx.provide('miniSwitch', refreshGraph);
  try {
    await Promise.all([settings.refresh(), sessions.refresh(), workspaces.refresh(), models.refresh(),
      plugins.refresh(), approvals.refresh(), graph.refresh()]);
    select.reconcileWorkspace(workspaces.get());
    workspaces.subscribe(() => select.reconcileWorkspace(workspaces.get()), lifetime.signal);
    const failures = await applyGraph();
    const coreFailure = [...failures].find(([id]) => graph.get().ui.some((entry) => entry.id === id && entry.required));
    if (coreFailure) throw new Error('Required UI plugin failed: ' + coreFailure[0] + ': ' + String(coreFailure[1]));
    if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
    const pluginChanges = {
      async sync(revision: number, reconnect: boolean) {
        await Promise.all([plugins.sync(revision, reconnect), graph.sync(revision, reconnect)]);
        const failures = await applyGraph();
        if (failures.size) report(new Error('Browser plugins failed: ' + [...failures.keys()].join(', ')));
      }
    };
    void observe({ sessions, workspaces, models, settings, approvals, plugins: pluginChanges }, lifetime.signal);
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
