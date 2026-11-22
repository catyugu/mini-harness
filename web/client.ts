import type { Settings } from '../src/config.js';
import { data } from './api.js';
import type { Bootstrap } from './types.js';

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

  activeConversation: string | undefined;

  apply = (settings: Settings) => {
    this.snapshot.settings = settings;
    document.documentElement.dataset.theme = settings.appearance;
    localStorage.setItem('mini-harness-theme', settings.appearance);
    for (const [key, size] of Object.entries(settings.typography)) document.documentElement.style.setProperty('--font-' + key, size + 'px');
    this.dispatchEvent(new Event('settings'));
  };

  refresh = async () => {
    const next = await data<Bootstrap>('/bootstrap');
    this.snapshot = { ...next, sessions: this.snapshot.sessions, workspaces: this.snapshot.workspaces };
    this.apply(this.snapshot.settings);
    this.dispatchEvent(new Event('bootstrap'));
  };

  on(event: 'settings' | 'bootstrap', listener: () => void, signal: AbortSignal) {
    this.addEventListener(event, listener, { signal });
  }
}
