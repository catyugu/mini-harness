import type { FrontendSetup } from '@mini-harness/ui-runtime/frontend';
import type { BrowserPrimitives } from '@mini-harness/contracts/browser';
import { button, field, dialog } from './primitives.js';
import { hydrateIcons } from './icons.js';

/** Elements contributed by plugins are hydrated without a global app-entry pass. */
const setup: FrontendSetup = (ctx, api) => {
  const primitives: BrowserPrimitives = {
    button, field, dialog,
    status(text, kind = 'status') {
      const node = document.createElement('p');
      node.className = 'hint';
      node.setAttribute('role', kind);
      node.textContent = text;
      return node;
    },
    menu(label, items) {
      const node = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = label;
      node.append(summary, ...items);
      return node;
    }
  };
  ctx.provide('miniPrimitives', primitives);
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes)
      if (node instanceof HTMLElement) hydrateIcons(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  hydrateIcons();
  api.onDispose(() => observer.disconnect());
};

export default setup;
