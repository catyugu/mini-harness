import type { Context } from 'mini-harness/cordis';
import type { BrowserPrimitives } from './api.ts';
import { button, field, dialog } from './primitives.ts';
import { hydrateIcons, icon } from './icons.ts';

/** Elements contributed by plugins are hydrated without a global app-entry pass. */
const setup = (ctx: Context) => {
  const primitives: BrowserPrimitives = {
    button,
    field,
    dialog,
    icon,
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
    },
  };
  ctx.provide('miniPrimitives', primitives);
  const observer = new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) if (node instanceof HTMLElement) hydrateIcons(node);
  });
  observer.observe(document.body, { childList: true, subtree: true });
  hydrateIcons();
  ctx.effect(() => () => observer.disconnect());
};

export default { inject: ['miniAppearance'], provide: ['miniPrimitives'], apply: setup };
