import type { BrowserPlugin } from '../web/kernel/extensions.js';
import { hydrateIcons } from './icons.js';

/** Elements contributed by plugins are hydrated without a global app-entry pass. */
export const primitivesPlugin: BrowserPlugin = {
  id: 'core:primitives',
  setup(_ctx, api) {
    const observer = new MutationObserver(hydrateIcons);
    observer.observe(document.body, { childList: true, subtree: true });
    hydrateIcons();
    api.onDispose(() => observer.disconnect());
  }
};
