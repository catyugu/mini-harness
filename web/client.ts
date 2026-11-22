import type { Settings } from '../src/config.js';
import type { Conversation } from '../src/registry.js';
import type { NavigationEvent } from '../src/navigation-events.js';
import type { RunEvent, RunInfo } from '../src/protocol.js';
import { api, data, payload, readEvents, wait } from './api.js';
import type { Bootstrap, ConversationView } from './types.js';

export class BrowserState extends EventTarget {
  constructor(private snapshot: Bootstrap) {
    super();
    this.selectedWorkspace = localStorage.getItem('mini-harness-workspace');
    this.reconcileWorkspace();
    this.apply(snapshot.settings);
  }

  get = () => this.snapshot;

  selectedWorkspace: string | undefined;

  selectWorkspace(id: string) {
    this.selectedWorkspace = id;
    if (id) localStorage.setItem('mini-harness-workspace', id);
    else localStorage.removeItem('mini-harness-workspace');
  }

  reconcileWorkspace() {
    if (!this.snapshot.workspaces.some(({ id }) => id === this.selectedWorkspace))
      this.selectWorkspace(this.snapshot.workspaces[0]?.id);
  }

  initialConversation() {
    const remembered = sessionStorage.getItem('mini-harness-active');
    const { sessions, workspaces } = this.snapshot;
    const available = sessions.filter(({ workspaceId }) => workspaces.some(({ id }) => id === workspaceId));
    return available.find(({ id }) => id === remembered) ??
      available.find(({ parentId, workspaceId }) => !parentId && workspaceId === this.selectedWorkspace);
  }

  activeConversation: string | undefined;
  session = (id = this.activeConversation) => this.snapshot.sessions.find((entry) => entry.id === id);
  workspace = () => this.snapshot.workspaces.find(({ id }) => id === this.selectedWorkspace);
  scope = () => this.selectedWorkspace && { workspaceId: this.selectedWorkspace, sessionId: this.activeConversation };

  selectConversation(item?: Conversation, revealWorkspace = true) {
    this.activeConversation = item?.id;
    if (item) {
      this.selectWorkspace(item.workspaceId);
      sessionStorage.setItem('mini-harness-active', item.id);
    } else sessionStorage.removeItem('mini-harness-active');
    this.dispatchEvent(new CustomEvent('selection', { detail: { item, revealWorkspace } }));
    this.changed();
  }

  changed() { this.dispatchEvent(new Event('navigation')); }

  applyNavigation(event: NavigationEvent) {
    const snapshot = this.snapshot;
    if (event.type === 'snapshot') {
      snapshot.workspaces = event.workspaces;
      snapshot.sessions = event.sessions;
    } else if (event.type === 'workspaces') snapshot.workspaces = event.workspaces;
    else {
      const id = event.type === 'session' ? event.session.id : event.id;
      snapshot.sessions = snapshot.sessions.filter((entry) => entry.id !== id);
      if (event.type === 'session') {
        snapshot.sessions.unshift(event.session);
        snapshot.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      }
    }
    this.reconcileWorkspace();
    this.changed();
  }

  apply = (settings: Settings) => {
    this.snapshot.settings = settings;
    document.documentElement.dataset.theme = settings.appearance;
    this.dispatchEvent(new Event('settings'));
  };

  refresh = async () => {
    const next = await data<Bootstrap>('/bootstrap');
    this.snapshot = { ...next, sessions: this.snapshot.sessions, workspaces: this.snapshot.workspaces };
    this.apply(this.snapshot.settings);
    this.dispatchEvent(new Event('bootstrap'));
  };

  on(event: 'settings' | 'bootstrap' | 'navigation', listener: () => void, signal: AbortSignal) {
    this.addEventListener(event, listener, { signal });
  }
}

export const isRunning = (run?: RunInfo) => run?.state === 'queued' || run?.state === 'running';
export const readConversation = (id: string, signal: AbortSignal) => data<ConversationView>('/sessions/' + id, { signal });

export async function observeRun(item: ConversationView, signal: AbortSignal, accept: (event: RunEvent) => void, reconnect: () => void) {
  const url = '/sessions/' + item.id + '/events?run=' + item.run.id + '&after=';
  let cursor = item.run.sequence, retries = 0, ended = false;
  while (!signal.aborted && !ended) {
    try {
      const response = await api(url + cursor, { signal });
      await readEvents<RunEvent>(response, (event) => {
        if (signal.aborted || event.sequence <= cursor && event.type !== 'snapshot') return;
        cursor = event.sequence;
        accept(event);
        if (event.type === 'run' || event.type === 'snapshot') ended = !isRunning(event.run);
      });
      if (!ended) throw new Error('Connection closed');
    } catch {
      if (signal.aborted) return;
      reconnect();
      await wait(Math.min(5000, 500 * ++retries), signal);
      if (signal.aborted) return;
      try {
        const latest = await readConversation(item.id, signal);
        if (latest.run?.id !== item.run.id || !isRunning(latest.run)) return latest;
      } catch { /* Retry while the conversation remains selected. */ }
    }
  }
  if (!signal.aborted) return readConversation(item.id, signal);
}

export async function exportSessions(ids: string[], signal: AbortSignal) {
  const response = await api('/sessions/export', { ...payload('POST', { ids }), signal });
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'mini-harness-sessions.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
