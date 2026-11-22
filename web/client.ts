import type { Settings } from '../src/config.js';
import { data, setWorkspace } from './api.js';
import type { Bootstrap } from './types.js';

export class BrowserState extends EventTarget {
  constructor(private snapshot: Bootstrap) {
    super();
    setWorkspace(snapshot.workspace);
    this.apply(snapshot.settings);
  }

  get = () => this.snapshot;

  activeConversation: string | undefined;

  apply = (settings: Settings) => {
    this.snapshot.settings = settings;
    document.documentElement.dataset.theme = settings.appearance;
    this.dispatchEvent(new Event('settings'));
  };

  refresh = async () => {
    this.snapshot = await data<Bootstrap>('/bootstrap');
    this.apply(this.snapshot.settings);
    this.dispatchEvent(new Event('bootstrap'));
  };

  on(event: 'settings' | 'bootstrap', listener: () => void, signal: AbortSignal) {
    this.addEventListener(event, listener, { signal });
  }
}
