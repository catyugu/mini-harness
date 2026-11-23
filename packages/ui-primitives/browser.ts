import type { BrowserPlugin } from '../ui-runtime/frontend.js';
import { hydrateIcons } from './icons.js';

/** Elements contributed by plugins are hydrated without a global app-entry pass. */
export const primitivesPlugin: BrowserPlugin = {
  id: 'core:primitives',
  setup(_ctx, api) {
    const observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes)
        if (node instanceof HTMLElement) hydrateIcons(node);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    hydrateIcons();
    api.onDispose(() => observer.disconnect());
  }
};

export default primitivesPlugin;
